import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository as TypeOrmRepository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { PowerBIReportCache } from './entities/powerbi-report-cache.entity';

export interface PowerBIReport {
  id: string;
  name: string;
  reportType: string;
  format: string;
  description: string;
  datasetId: string;
  datasetWorkspaceId: string;
  webUrl: string;
  embedUrl: string;
}

export interface PowerBIWorkspace {
  id: string;
  name: string;
  type: string;
  state: string;
  isOnDedicatedCapacity: boolean;
}

export interface PowerBIDataset {
  id: string;
  name: string;
  webUrl: string;
  configuredBy: string;
  isRefreshable: boolean;
  lastRefreshTime?: string;
}

export interface PowerBISchemaColumn {
  name: string;
  dataType: string;
  sanitizedName: string;
}

export interface PowerBIRefreshHistory {
  requestId: string;
  refreshType: string;
  startTime: string;
  endTime: string;
  status: string;
}

@Injectable()
export class PowerbiService {
  private readonly logger = new Logger(PowerbiService.name);
  private readonly useMock: boolean;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectRepository(PowerBIReportCache)
    private readonly cacheRepository: TypeOrmRepository<PowerBIReportCache>,
  ) {
    this.useMock = this.configService.get<string>('USE_POWERBI_MOCK') === 'true';
    this.logger.log(`Power BI Service initialized in ${this.useMock ? 'MOCK' : 'LIVE'} mode`);
    
    // Initial sync
    setTimeout(() => this.syncReportsToCache(), 5000);
  }

  // ─── Authentication ──────────────────────────────────────────────
  async getAccessToken(): Promise<string> {
    if (this.useMock) return 'mock-access-token';

    const tenantId = this.configService.get<string>('POWERBI_TENANT_ID')!;
    const clientId = this.configService.get<string>('POWERBI_CLIENT_ID')!;
    const clientSecret = this.configService.get<string>('POWERBI_CLIENT_SECRET')!;

    const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('scope', 'https://analysis.windows.net/powerbi/api/.default');
    params.append('client_secret', clientSecret);
    params.append('grant_type', 'client_credentials');

    const response = await firstValueFrom(
      this.httpService.post(tokenEndpoint, params),
    );
    return response.data.access_token;
  }

  // ─── Reports ─────────────────────────────────────────────────────
  async getReports(): Promise<PowerBIReport[]> {
    if (this.useMock) return this.getMockReports();

    const workspaces = await this.getWorkspaces();
    const allReports: PowerBIReport[] = [];
    
    for (const workspace of workspaces) {
      try {
        const reports = await this.getReportsInGroup(workspace.id);
        allReports.push(...reports);
      } catch (e) {
        this.logger.warn(`Could not fetch reports for workspace ${workspace.id}: ${e.message}`);
      }
    }
    return allReports;
  }

  async getPagedReports(page: number, limit: number, search: string = '') {
    const query = this.cacheRepository.createQueryBuilder('report');
    
    if (search) {
      query.where('LOWER(report.name) LIKE LOWER(:search)', { search: `%${search}%` });
    }
    
    const [data, total] = await query
      .orderBy('report.name', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      data,
      total,
      page,
      lastPage: Math.ceil(total / limit),
    };
  }

  async getReportsInGroup(groupId: string): Promise<PowerBIReport[]> {
    if (this.useMock) return this.getMockReports();

    const token = await this.getAccessToken();
    const response = await firstValueFrom(
      this.httpService.get(
        `https://api.powerbi.com/v1.0/myorg/groups/${groupId}/reports`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );
    return response.data.value;
  }

  async getReportById(reportId: string): Promise<PowerBIReport> {
    if (this.useMock) {
      const reports = this.getMockReports();
      return reports.find((r) => r.id === reportId) || reports[0];
    }

    const token = await this.getAccessToken();
    const response = await firstValueFrom(
      this.httpService.get(
        `https://api.powerbi.com/v1.0/myorg/reports/${reportId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );
    return response.data;
  }

  // ─── Workspaces (Groups) ─────────────────────────────────────────
  async getWorkspaces(): Promise<PowerBIWorkspace[]> {
    if (this.useMock) return this.getMockWorkspaces();

    const token = await this.getAccessToken();
    const response = await firstValueFrom(
      this.httpService.get('https://api.powerbi.com/v1.0/myorg/groups', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return response.data.value;
  }

  // ─── Datasets ────────────────────────────────────────────────────
  async getDatasets(): Promise<PowerBIDataset[]> {
    if (this.useMock) {
      const datasets = this.getMockDatasets();
      datasets[0].lastRefreshTime = new Date().toISOString();
      return datasets;
    }

    const workspaces = await this.getWorkspaces();
    const allDatasets: PowerBIDataset[] = [];

    for (const workspace of workspaces) {
      try {
        const datasets = await this.getDatasetsInGroup(workspace.id);
        allDatasets.push(...datasets);
      } catch (e) {
        this.logger.warn(`Could not fetch datasets for workspace ${workspace.id}: ${e.message}`);
      }
    }
    return allDatasets;
  }

  async getDatasetById(datasetId: string): Promise<PowerBIDataset> {
    if (this.useMock) {
      const ds = this.getMockDatasets()[0];
      ds.lastRefreshTime = new Date().toISOString();
      return ds;
    }

    const token = await this.getAccessToken();
    try {
      const response = await firstValueFrom(
        this.httpService.get(`https://api.powerbi.com/v1.0/myorg/datasets/${datasetId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      return response.data;
    } catch (e) {
      this.logger.error(`Failed to get dataset info for ${datasetId}: ${JSON.stringify(e.response?.data || e.message)}`);
      // Return a basic object if info fetch fails, to prevent blocking the flow
      return {
        id: datasetId,
        name: 'Power BI Dataset',
        webUrl: '',
        configuredBy: '',
        isRefreshable: true,
        lastRefreshTime: new Date().toISOString()
      };
    }
  }

  // ─── Schema & Query Execution ────────────────────────────────────

  async getDatasetTables(datasetId: string): Promise<string[]> {
    if (this.useMock) {
      return ['Inventory', 'Finance', 'Sourcing', 'Sales'];
    }

    const queries = [
      'SELECT [Name] FROM $SYSTEM.TMSCHEMA_TABLES',
      'SELECT [TABLE_NAME] FROM $SYSTEM.DBSCHEMA_TABLES WHERE [TABLE_TYPE] = \'TABLE\''
    ];

    for (const daxQuery of queries) {
      try {
        const result = await this.executeDatasetQuery(datasetId, daxQuery);
        if (result.results && result.results[0]?.tables?.[0]?.rows) {
          const rows = result.results[0].tables[0].rows;
          if (rows.length > 0) {
            const firstRow = rows[0];
            const nameKey = Object.keys(firstRow).find(k => 
              k.toLowerCase().includes('name') || k.toLowerCase().includes('table_name')
            );
            
            if (nameKey) {
              const tableNames = rows
                .map(row => row[nameKey])
                .filter(name => {
                  if (!name) return false;
                  const lower = name.toLowerCase();
                  return !lower.startsWith('rownumber') && 
                         !lower.startsWith('$local') && 
                         !lower.includes('localdatetable') &&
                         !lower.includes('variation') &&
                         !lower.startsWith('datetabletemplate_');
                });
              
              this.logger.log(`Discovered ${tableNames.length} visible tables for dataset ${datasetId}`);
              return tableNames;
            }
          }
        }
      } catch (e) {
        this.logger.warn(`Query "${daxQuery}" failed for dataset ${datasetId}: ${e.message}`);
      }
    }

    this.logger.error(`All table detection queries failed for dataset ${datasetId}`);
    return [];
  }

  async getDatasetSchema(datasetId: string, tableName?: string): Promise<PowerBISchemaColumn[]> {
    if (this.useMock) {
      return [
        { name: 'ID', dataType: 'Int64', sanitizedName: 'id' },
        { name: 'Report Name', dataType: 'String', sanitizedName: 'report_name' },
        { name: 'Sales Amount', dataType: 'Double', sanitizedName: 'sales_amount' },
        { name: 'Order Date', dataType: 'DateTime', sanitizedName: 'order_date' },
      ];
    }

    if (!tableName) {
      const tables = await this.getDatasetTables(datasetId);
      if (tables.length > 0) {
        tableName = tables[0];
      } else {
        throw new Error('No tables found in dataset.');
      }
    }

    // Use DBSCHEMA_COLUMNS for most reliable schema detection
    // Prioritize EVALUATE TOPN(1) as it returns exactly what the user sees in the report
    const cleanTableName = tableName.startsWith('$') ? tableName.substring(1) : tableName;
    const evalQuery = `EVALUATE TOPN(1, '${cleanTableName.replace(/'/g, "''")}')`;
    
    try {
      const evalResult = await this.executeDatasetQuery(datasetId, evalQuery);
      if (evalResult.results?.[0]?.tables?.[0]?.rows) {
        const evalRows = evalResult.results[0].tables[0].rows;
        if (evalRows.length > 0) {
          const firstRow = evalRows[0];
          const columns = Object.keys(firstRow)
            .filter(key => !key.startsWith('RowNumber-'))
            .map(key => ({
              name: key,
              dataType: 'String', 
              sanitizedName: this.sanitizeName(key)
            }));
          
          if (columns.length > 0) {
            return columns;
          }
        }
      }
    } catch (evalError) {
      this.logger.warn(`EVALUATE failed for "${cleanTableName}": ${evalError.message}. Trying DMV...`);
    }

    // Fallback to DBSCHEMA_COLUMNS
    try {
      let daxQuery = `SELECT [COLUMN_NAME], [DATA_TYPE] FROM $SYSTEM.DBSCHEMA_COLUMNS WHERE [TABLE_NAME] = '${cleanTableName.replace(/'/g, "''")}'`;
      let result = await this.executeDatasetQuery(datasetId, daxQuery);
      let rows = result.results?.[0]?.tables?.[0]?.rows || [];

      if (rows.length === 0 && cleanTableName !== tableName) {
        daxQuery = `SELECT [COLUMN_NAME], [DATA_TYPE] FROM $SYSTEM.DBSCHEMA_COLUMNS WHERE [TABLE_NAME] = '${tableName.replace(/'/g, "''")}'`;
        result = await this.executeDatasetQuery(datasetId, daxQuery);
        rows = result.results?.[0]?.tables?.[0]?.rows || [];
      }

      if (rows.length > 0) {
        const columns = rows.map(row => {
          const name = row['[COLUMN_NAME]'] || row['COLUMN_NAME'];
          const typeId = row['[DATA_TYPE]'] || row['DATA_TYPE'];
          
          let dataType = 'String';
          if ([2, 3, 20].includes(typeId)) dataType = 'Int64';
          if ([4, 5, 6, 14].includes(typeId)) dataType = 'Double';
          if ([7, 133, 134, 135].includes(typeId)) dataType = 'DateTime';
          if ([11].includes(typeId)) dataType = 'Boolean';

          return {
            name: name,
            dataType: dataType,
            sanitizedName: this.sanitizeName(name)
          };
        }).filter(col => !col.name.startsWith('RowNumber-'));

        if (columns.length > 0) {
          return columns;
        }
      }

      throw new Error(`Could not detect schema for table "${tableName}".`);
    } catch (e) {
      this.logger.error(`Schema detection failed for ${tableName}: ${e.message}`);
      throw e;
    }
  }

  async executeDatasetQuery(datasetId: string, dax: string): Promise<any> {
    if (this.useMock) {
      return { 
        results: [{ 
          tables: [{ 
            rows: [
              { id: 1, report_name: 'Mock A', sales_amount: 100.50, order_date: '2026-04-22' },
              { id: 2, report_name: 'Mock B', sales_amount: 250.75, order_date: '2026-04-21' }
            ] 
          }] 
        }] 
      };
    }

    const token = await this.getAccessToken();
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `https://api.powerbi.com/v1.0/myorg/datasets/${datasetId}/executeQueries`,
          { queries: [{ query: dax }] },
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      );
      return response.data;
    } catch (e) {
      const errorData = e.response?.data;
      this.logger.error(`DAX Query Failed: ${dax}`);
      this.logger.error(`Error Details: ${JSON.stringify(errorData || e.message)}`);
      throw new Error(errorData?.error?.message || e.message);
    }
  }

  public sanitizeName(name: string): string {
    // Handle Table[Column] format from DAX
    let cleanName = name;
    if (name.includes('[') && name.endsWith(']')) {
      const match = name.match(/\[(.*?)\]/);
      if (match) cleanName = match[1];
    }
    return cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_') // Replace non-alphanumeric with underscore
      .replace(/_+/g, '_')        // Remove double underscores
      .replace(/^_|_$/g, '');     // Remove leading/trailing underscores
  }

  async getDatasetsInGroup(groupId: string): Promise<PowerBIDataset[]> {
    if (this.useMock) return this.getMockDatasets();

    const token = await this.getAccessToken();
    const response = await firstValueFrom(
      this.httpService.get(
        `https://api.powerbi.com/v1.0/myorg/groups/${groupId}/datasets`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );
    return response.data.value;
  }

  // ─── Refresh ─────────────────────────────────────────────────────
  async triggerRefresh(datasetId: string, groupId?: string): Promise<{ success: boolean; message: string }> {
    if (this.useMock) {
      return { success: true, message: `Mock refresh triggered for dataset ${datasetId}` };
    }

    const token = await this.getAccessToken();
    const url = groupId
      ? `https://api.powerbi.com/v1.0/myorg/groups/${groupId}/datasets/${datasetId}/refreshes`
      : `https://api.powerbi.com/v1.0/myorg/datasets/${datasetId}/refreshes`;

    await firstValueFrom(
      this.httpService.post(url, null, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return { success: true, message: `Refresh triggered for dataset ${datasetId}` };
  }

  async getRefreshHistory(datasetId: string, groupId?: string): Promise<PowerBIRefreshHistory[]> {
    if (this.useMock) return this.getMockRefreshHistory();

    const token = await this.getAccessToken();
    const url = groupId
      ? `https://api.powerbi.com/v1.0/myorg/groups/${groupId}/datasets/${datasetId}/refreshes`
      : `https://api.powerbi.com/v1.0/myorg/datasets/${datasetId}/refreshes`;

    const response = await firstValueFrom(
      this.httpService.get(url, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return response.data.value;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  MOCK DATA — Matches real Power BI API response structure exactly
  // ═══════════════════════════════════════════════════════════════════

  private getMockReports(): PowerBIReport[] {
    return [
      {
        id: 'eae1d8d4-4dbd-4d3c-b848-8a8b19c5f873',
        name: 'Hub Sourcing Dashboard',
        reportType: 'PowerBIReport',
        format: 'PBIXLegacy',
        description: 'Global supply chain visibility and hub performance metrics.',
        datasetId: '38ea6f0b-c6fc-47b2-b17c-fdc722df4813',
        datasetWorkspaceId: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db',
        webUrl: 'https://app.powerbi.com/groups/me/reports/eae1d8d4-4dbd-4d3c-b848-8a8b19c5f873',
        embedUrl: 'https://app.powerbi.com/reportEmbed?reportId=eae1d8d4-4dbd-4d3c-b848-8a8b19c5f873',
      },
      {
        id: 'b2c3d4e5-1234-5678-9abc-def012345678',
        name: 'Sales Performance Report',
        reportType: 'PowerBIReport',
        format: 'PBIRLegacy',
        description: 'Monthly sales KPIs, revenue trends, and regional performance.',
        datasetId: 'a1b2c3d4-aaaa-bbbb-cccc-ddddeeee1111',
        datasetWorkspaceId: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db',
        webUrl: 'https://app.powerbi.com/groups/me/reports/b2c3d4e5-1234-5678-9abc-def012345678',
        embedUrl: 'https://app.powerbi.com/reportEmbed?reportId=b2c3d4e5-1234-5678-9abc-def012345678',
      },
      {
        id: 'c3d4e5f6-2345-6789-abcd-ef0123456789',
        name: 'Inventory Summary',
        reportType: 'PowerBIReport',
        format: 'PBIRLegacy',
        description: 'Real-time stock levels across all regional distribution centers.',
        datasetId: 'b2c3d4e5-bbbb-cccc-dddd-eeee11112222',
        datasetWorkspaceId: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db',
        webUrl: 'https://app.powerbi.com/groups/me/reports/c3d4e5f6-2345-6789-abcd-ef0123456789',
        embedUrl: 'https://app.powerbi.com/reportEmbed?reportId=c3d4e5f6-2345-6789-abcd-ef0123456789',
      },
      {
        id: 'd4e5f6a7-3456-7890-bcde-f01234567890',
        name: 'Finance Overview',
        reportType: 'PowerBIReport',
        format: 'PBIRLegacy',
        description: 'Cash flow analysis, P&L statements, and budget tracking.',
        datasetId: 'd4e5f6a7-aaaa-bbbb-cccc-ddddeeee1111',
        datasetWorkspaceId: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db',
        webUrl: 'https://app.powerbi.com/groups/me/reports/d4e5f6a7-3456-7890-bcde-f01234567890',
        embedUrl: 'https://app.powerbi.com/reportEmbed?reportId=d4e5f6a7-3456-7890-bcde-f01234567890',
      },
      {
        id: 'e5f6a7b8-4567-8901-cdef-012345678901',
        name: 'Customer Insights',
        reportType: 'PowerBIReport',
        format: 'PBIRLegacy',
        description: 'Customer churn analysis, retention rates, and demographic segmentation.',
        datasetId: 'e5f6a7b8-aaaa-bbbb-cccc-ddddeeee1111',
        datasetWorkspaceId: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db',
        webUrl: 'https://app.powerbi.com/groups/me/reports/e5f6a7b8-4567-8901-cdef-012345678901',
        embedUrl: 'https://app.powerbi.com/reportEmbed?reportId=e5f6a7b8-4567-8901-cdef-012345678901',
      },
      {
        id: 'f6a7b8c9-5678-9012-def0-123456789012',
        name: 'HR Analytics Report',
        reportType: 'PowerBIReport',
        format: 'PBIRLegacy',
        description: 'Employee engagement scores, turnover rates, and head count tracking.',
        datasetId: 'f6a7b8c9-aaaa-bbbb-cccc-ddddeeee1111',
        datasetWorkspaceId: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db',
        webUrl: 'https://app.powerbi.com/groups/me/reports/f6a7b8c9-5678-9012-def0-123456789012',
        embedUrl: 'https://app.powerbi.com/reportEmbed?reportId=f6a7b8c9-5678-9012-def0-123456789012',
      },
      {
        id: 'a7b8c9d0-6789-0123-ef01-234567890123',
        name: 'IT Infrastructure Dashboard',
        reportType: 'PowerBIReport',
        format: 'PBIRLegacy',
        description: 'Server uptime monitoring, ticket resolution times, and system health.',
        datasetId: 'a7b8c9d0-aaaa-bbbb-cccc-ddddeeee1111',
        datasetWorkspaceId: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db',
        webUrl: 'https://app.powerbi.com/groups/me/reports/a7b8c9d0-6789-0123-ef01-234567890123',
        embedUrl: 'https://app.powerbi.com/reportEmbed?reportId=a7b8c9d0-6789-0123-ef01-234567890123',
      }
    ];
  }

  private getMockWorkspaces(): PowerBIWorkspace[] {
    return [
      {
        id: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db',
        name: 'Horizon Group Analytics',
        type: 'Workspace',
        state: 'Active',
        isOnDedicatedCapacity: false,
      },
      {
        id: 'd4e5f6a7-3456-7890-bcde-f01234567890',
        name: 'Sales Team Workspace',
        type: 'Workspace',
        state: 'Active',
        isOnDedicatedCapacity: false,
      },
    ];
  }

  private getMockDatasets(): PowerBIDataset[] {
    return [
      {
        id: '38ea6f0b-c6fc-47b2-b17c-fdc722df4813',
        name: 'Hub Sourcing Dataset',
        webUrl: 'https://app.powerbi.com/groups/me/datasets/38ea6f0b-c6fc-47b2-b17c-fdc722df4813',
        configuredBy: 'HMaduwantha@hgusa.com',
        isRefreshable: true,
      },
      {
        id: 'a1b2c3d4-aaaa-bbbb-cccc-ddddeeee1111',
        name: 'Sales Dataset',
        webUrl: 'https://app.powerbi.com/groups/me/datasets/a1b2c3d4-aaaa-bbbb-cccc-ddddeeee1111',
        configuredBy: 'HMaduwantha@hgusa.com',
        isRefreshable: true,
      },
    ];
  }

  // ─── Caching & Auto-suggestions ──────────────────────────────────

  @Cron('0 0 * * *') // Run every day at midnight
  async syncReportsToCache() {
    try {
      this.logger.log('Starting Power BI report cache synchronization...');
      
      // Get all workspaces the SP has access to
      const workspaces = await this.getWorkspaces();
      this.logger.log(`Found ${workspaces.length} accessible workspaces.`);
      
      let totalSynced = 0;
      
      for (const workspace of workspaces) {
        try {
          const reports = await this.getReportsInGroup(workspace.id);
          this.logger.log(`Syncing ${reports.length} reports from workspace: ${workspace.name}`);
          
          for (const report of reports) {
            await this.cacheRepository.upsert({
              id: report.id,
              name: report.name,
              datasetId: report.datasetId,
              workspaceId: workspace.id,
            }, ['id']);
            totalSynced++;
          }
        } catch (wsError) {
          this.logger.warn(`Failed to sync reports for workspace ${workspace.name}: ${wsError.message}`);
        }
      }
      
      this.logger.log(`Successfully synced ${totalSynced} reports to cache.`);
    } catch (error) {
      this.logger.error(`Failed to sync reports to cache: ${error.message}`);
    }
  }

  async searchCachedReports(query: string): Promise<PowerBIReportCache[]> {
    return this.cacheRepository
      .createQueryBuilder('report')
      .where('LOWER(report.name) LIKE LOWER(:query)', { query: `%${query}%` })
      .limit(10)
      .getMany();
  }

  private getMockRefreshHistory(): PowerBIRefreshHistory[] {
    return [
      {
        requestId: 'req-001',
        refreshType: 'Scheduled',
        startTime: '2026-04-21T06:00:00Z',
        endTime: '2026-04-21T06:05:30Z',
        status: 'Completed',
      },
      {
        requestId: 'req-002',
        refreshType: 'OnDemand',
        startTime: '2026-04-20T14:00:00Z',
        endTime: '2026-04-20T14:03:12Z',
        status: 'Completed',
      },
      {
        requestId: 'req-003',
        refreshType: 'Scheduled',
        startTime: '2026-04-19T06:00:00Z',
        endTime: '2026-04-19T06:00:45Z',
        status: 'Failed',
      },
    ];
  }
}
