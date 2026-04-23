import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';
import { AutomationTask } from './entities/automation-task.entity';
import { PowerbiModule } from '../powerbi/powerbi.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AutomationTask]),
    ScheduleModule.forRoot(),
    PowerbiModule,
  ],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
