import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('powerbi_report_cache')
export class PowerBIReportCache {
  @PrimaryColumn()
  id: string; // Power BI Report ID

  @Column()
  name: string;

  @Column()
  datasetId: string;

  @Column({ nullable: true })
  workspaceId: string;

  @UpdateDateColumn()
  lastSyncedAt: Date;
}
