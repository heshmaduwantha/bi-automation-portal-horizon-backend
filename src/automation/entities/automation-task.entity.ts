import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('automation_tasks')
export class AutomationTask {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  reportName: string;

  @Column()
  reportId: string;

  @Column()
  workspaceId: string;

  @Column()
  datasetId: string;

  @Column({ nullable: true })
  tableName: string; // The auto-created table name

  @Column('simple-array')
  primaryKeys: string[]; // User selected PKs

  @Column()
  cronExpression: string; // e.g., '0 0 * * *' (Every day at midnight)

  @Column({ default: 'Pending' })
  status: string; // Running, Success, Failed, Idle

  @Column({ type: 'timestamp', nullable: true })
  lastRunTime: Date;

  @Column({ type: 'timestamp', nullable: true })
  nextRunTime: Date;

  @Column({ default: 0 })
  lastRunRecordCount: number;

  @Column({ type: 'text', nullable: true })
  lastErrorMessage: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
