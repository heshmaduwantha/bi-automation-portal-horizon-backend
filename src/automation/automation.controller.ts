import { Controller, Get, Post, Delete, Body, Param, Query } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { AutomationTask } from './entities/automation-task.entity';

@Controller('automation')
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  @Post('schedule')
  createSchedule(@Body() taskData: Partial<AutomationTask>) {
    return this.automationService.createSchedule(taskData);
  }

  @Get('tasks')
  getAllTasks() {
    return this.automationService.getAllTasks();
  }

  @Post('tasks/:id/run')
  manualRun(@Param('id') id: string, @Query('limit') limit: number = 1000) {
    return this.automationService.executeTask(+id, Number(limit));
  }

  @Delete('tasks/:id')
  deleteTask(@Param('id') id: string) {
    return this.automationService.deleteTask(+id);
  }
}
