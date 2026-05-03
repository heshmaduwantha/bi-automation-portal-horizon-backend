import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AutomationTask } from './entities/automation-task.entity';
import { PowerbiService, PowerBISchemaColumn } from '../powerbi/powerbi.service';

@Injectable()
export class AutomationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    @InjectRepository(AutomationTask)
    private readonly taskRepository: Repository<AutomationTask>,
    private readonly powerbiService: PowerbiService,
    private readonly dataSource: DataSource,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // ─── Startup Logic ────────────────────────────────────────────────
  async onApplicationBootstrap() {
    this.logger.log('Restoring scheduled tasks...');
    const tasks = await this.taskRepository.find();
    for (const task of tasks) {
      this.scheduleCronJob(task);
    }
  }

  // ─── Task Management ──────────────────────────────────────────────
  async createSchedule(data: Partial<AutomationTask>) {
    // 0. Check for duplicates (Report + Table)
    const existing = await this.taskRepository.findOneBy({ 
      reportId: data.reportId,
      pbiTableName: data.pbiTableName 
    });
    
    if (existing) {
       throw new Error(`Table "${data.pbiTableName}" in report "${data.reportName}" is already scheduled.`);
    }

    // 1. Get Schema
    const schema = await this.powerbiService.getDatasetSchema(data.datasetId!, data.pbiTableName);
    
    // 2. Create target table name (dashboard_name_tablename)
    const sanitizedReportName = (data.reportName || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const sanitizedTableName = (data.pbiTableName || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_');
    const tableName = `pbi_${sanitizedReportName}_${sanitizedTableName}`;
    data.tableName = tableName;

    // 3. Create table in DB
    await this.createDynamicTable(tableName, schema, data.primaryKeys || []);

    // 4. Save Task
    const task = await this.taskRepository.save(data as AutomationTask);

    // 5. Schedule Job
    this.scheduleCronJob(task);

    return task;
  }

  private scheduleCronJob(task: AutomationTask) {
    const jobName = `task-${task.id}`;
    
    // Remove if exists
    if (this.schedulerRegistry.getCronJobs().has(jobName)) {
      this.schedulerRegistry.deleteCronJob(jobName);
    }

    const job = new CronJob(task.cronExpression, async () => {
      await this.executeTask(task.id);
    });

    this.schedulerRegistry.addCronJob(jobName, job);
    job.start();
    
    this.logger.log(`Scheduled task ${task.id} with cron: ${task.cronExpression}`);
  }

  // ─── Execution Logic ──────────────────────────────────────────────
  async executeTask(taskId: number, limit: number = 10000) {
    const task = await this.taskRepository.findOneBy({ id: taskId });
    if (!task) return;

    try {
      this.logger.log(`Executing automation task: ${task.reportName} - ${task.pbiTableName}`);
      await this.taskRepository.update(taskId, { status: 'Running' });

      // 1. Fetch Data
      // Use clean table name (strip $ if present for DAX)
      let daxTableName = task.pbiTableName;
      if (daxTableName.startsWith('$')) daxTableName = daxTableName.substring(1);

      const dax = `EVALUATE TOPN(${limit}, '${daxTableName}')`; 
      const queryResult = await this.powerbiService.executeDatasetQuery(task.datasetId, dax);
      const rows = queryResult.results[0].tables[0].rows;

      // 2. Perform Smart Upsert
      const recordCount = await this.upsertData(task.tableName, rows, task.primaryKeys);

      // 3. Update Status
      await this.taskRepository.update(taskId, {
        status: 'Success',
        lastRunTime: new Date(),
        lastRunRecordCount: recordCount,
        lastErrorMessage: undefined as any
      });
      
      this.logger.log(`Task ${task.reportName} completed. Imported ${recordCount} rows.`);
    } catch (error) {
      this.logger.error(`Task ${task.reportName} failed: ${error.message}`);
      await this.taskRepository.update(taskId, {
        status: 'Failed',
        lastRunTime: new Date(),
        lastErrorMessage: error.message
      });
    }
  }

  // ─── Database Magic ──────────────────────────────────────────────
  private async createDynamicTable(tableName: string, schema: PowerBISchemaColumn[], pks: string[]) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    
    try {
      let columnsSql = schema.map(col => {
        let type = 'TEXT';
        if (col.dataType === 'Int64') type = 'BIGINT';
        if (col.dataType === 'Double') type = 'DOUBLE PRECISION';
        if (col.dataType === 'DateTime') type = 'TIMESTAMP';
        if (col.dataType === 'Boolean') type = 'BOOLEAN';
        
        return `"${col.sanitizedName}" ${type}`;
      }).join(', ');

      if (pks && pks.length > 0) {
        const pkConstraint = `PRIMARY KEY (${pks.map(pk => `"${pk}"`).join(', ')})`;
        columnsSql += `, ${pkConstraint}`;
      }

      const sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${columnsSql})`;
      await queryRunner.query(sql);
      this.logger.log(`Dynamic table created: ${tableName}`);
    } finally {
      await queryRunner.release();
    }
  }

  private async upsertData(tableName: string, rows: any[], pks: string[]): Promise<number> {
    if (!rows || rows.length === 0) return 0;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const originalKeys = Object.keys(rows[0]);
      const sanitizedKeys = originalKeys.map(k => this.powerbiService.sanitizeName(k));
      const columnsSql = sanitizedKeys.map(k => `"${k}"`).join(', ');
      
      for (const row of rows) {
        const valuesSql = originalKeys.map(k => {
          const val = row[k];
          if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
          if (val === null) return 'NULL';
          return val;
        }).join(', ');
 
        let sql = `INSERT INTO "${tableName}" (${columnsSql}) VALUES (${valuesSql})`;
        
        if (pks && pks.length > 0) {
          const updateSet = sanitizedKeys
            .filter(k => !pks.includes(k)) // Don't update the PKs themselves
            .map(k => `"${k}" = EXCLUDED."${k}"`)
            .join(', ');
          
          if (updateSet) {
            sql += ` ON CONFLICT (${pks.map(pk => `"${pk}"`).join(', ')}) DO UPDATE SET ${updateSet}`;
          } else {
            sql += ` ON CONFLICT (${pks.map(pk => `"${pk}"`).join(', ')}) DO NOTHING`;
          }
        }

        await queryRunner.query(sql);
      }
      return rows.length;
    } finally {
      await queryRunner.release();
    }
  }

  async getAllTasks() {
    return this.taskRepository.find({ order: { createdAt: 'DESC' } });
  }

  async deleteTask(id: number) {
    const task = await this.taskRepository.findOneBy({ id });
    if (task) {
      const jobName = `task-${id}`;
      if (this.schedulerRegistry.getCronJobs().has(jobName)) {
        this.schedulerRegistry.deleteCronJob(jobName);
      }
      await this.taskRepository.delete(id);
    }
  }
}
