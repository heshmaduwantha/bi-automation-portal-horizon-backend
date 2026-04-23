import { Controller, Get, Post, Param, Query } from '@nestjs/common';
import { PowerbiService } from './powerbi.service';

@Controller('powerbi')
export class PowerbiController {
  constructor(private readonly powerbiService: PowerbiService) {}

  // ─── Reports ─────────────────────────────────────────────────────
  @Get('reports')
  getReports() {
    return this.powerbiService.getReports();
  }

  @Get('search-cache')
  searchCache(@Query('q') query: string) {
    return this.powerbiService.searchCachedReports(query || '');
  }

  @Get('reports/:id')
  getReportById(@Param('id') id: string) {
    return this.powerbiService.getReportById(id);
  }

  @Get('groups/:groupId/reports')
  getReportsInGroup(@Param('groupId') groupId: string) {
    return this.powerbiService.getReportsInGroup(groupId);
  }

  // ─── Workspaces ──────────────────────────────────────────────────
  @Get('workspaces')
  getWorkspaces() {
    return this.powerbiService.getWorkspaces();
  }

  // ─── Datasets ────────────────────────────────────────────────────
  @Get('datasets')
  getDatasets() {
    return this.powerbiService.getDatasets();
  }

  @Get('groups/:groupId/datasets')
  getDatasetsInGroup(@Param('groupId') groupId: string) {
    return this.powerbiService.getDatasetsInGroup(groupId);
  }

  @Get('datasets/:id')
  getDatasetById(@Param('id') id: string) {
    return this.powerbiService.getDatasetById(id);
  }

  @Get('datasets/:id/schema')
  getDatasetSchema(@Param('id') id: string) {
    return this.powerbiService.getDatasetSchema(id);
  }

  // ─── Refresh ─────────────────────────────────────────────────────
  @Post('datasets/:datasetId/refresh')
  triggerRefresh(
    @Param('datasetId') datasetId: string,
    @Query('groupId') groupId?: string,
  ) {
    return this.powerbiService.triggerRefresh(datasetId, groupId);
  }

  @Get('datasets/:datasetId/refresh-history')
  getRefreshHistory(
    @Param('datasetId') datasetId: string,
    @Query('groupId') groupId?: string,
  ) {
    return this.powerbiService.getRefreshHistory(datasetId, groupId);
  }
}
