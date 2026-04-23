import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { PowerbiController } from './powerbi.controller';
import { PowerbiService } from './powerbi.service';
import { PowerBIReportCache } from './entities/powerbi-report-cache.entity';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([PowerBIReportCache])],
  controllers: [PowerbiController],
  providers: [PowerbiService],
  exports: [PowerbiService],
})
export class PowerbiModule {}
