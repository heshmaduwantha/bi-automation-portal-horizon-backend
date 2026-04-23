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

    const token = await this.getAccessToken();
    const response = await firstValueFrom(
      this.httpService.get('https://api.powerbi.com/v1.0/myorg/reports', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return response.data.value;
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

    const token = await this.getAccessToken();
    const response = await firstValueFrom(
      this.httpService.get('https://api.powerbi.com/v1.0/myorg/datasets', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return response.data.value;
  }

  async getDatasetById(datasetId: string): Promise<PowerBIDataset> {
    if (this.useMock) {
      const ds = this.getMockDatasets()[0];
      ds.lastRefreshTime = new Date().toISOString();
      return ds;
    }

    const token = await this.getAccessToken();
    const response = await firstValueFrom(
      this.httpService.get(`https://api.powerbi.com/v1.0/myorg/datasets/${datasetId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return response.data;
  }

  // ─── Schema & Query Execution ────────────────────────────────────

  async getDatasetSchema(datasetId: string): Promise<PowerBISchemaColumn[]> {
    if (this.useMock) {
      return [
        { name: 'ID', dataType: 'Int64', sanitizedName: 'id' },
        { name: 'Report Name', dataType: 'String', sanitizedName: 'report_name' },
        { name: 'Sales Amount', dataType: 'Double', sanitizedName: 'sales_amount' },
        { name: 'Order Date', dataType: 'DateTime', sanitizedName: 'order_date' },
      ];
    }

    const daxQuery = 'SELECT [Name], [DataType] FROM $SYSTEM.TMSCHEMA_COLUMNS';
    const result = await this.executeDatasetQuery(datasetId, daxQuery);
    
    // Result from executeQueries is in a nested 'results' array
    const columns = result.results[0].tables[0].rows;
    return columns.map(col => ({
      name: col['[Name]'],
      dataType: col['[DataType]'],
      sanitizedName: this.sanitizeName(col['[Name]'])
    }));
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
    const response = await firstValueFrom(
      this.httpService.post(
        `https://api.powerbi.com/v1.0/myorg/datasets/${datasetId}/executeQueries`,
        { queries: [{ query: dax }] },
        { headers: { Authorization: `Bearer ${token}` } },
      ),
    );
    return response.data;
  }

  private sanitizeName(name: string): string {
    return name
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
      const reports = await this.getReports();
      
      for (const report of reports) {
        await this.cacheRepository.upsert({
          id: report.id,
          name: report.name,
          datasetId: report.datasetId,
          workspaceId: 'cda4f662-6824-4e18-9cc3-ac5c56dcb8db', // Mock workspace ID
        }, ['id']);
      }
      
      this.logger.log(`Successfully synced ${reports.length} reports to cache.`);
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
