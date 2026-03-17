const log = require("fancy-log");

class MetricsScheduler {
  constructor(defaultInterval) {
    this.tasks = new Map();
    this.running = false;
    this.defaultInterval = defaultInterval;
    this.currentInterval = defaultInterval;
    this.timer = null;
  }

  addTask(name, fn, args = []) {
    this.tasks.set(name, { 
      fn, 
      args, 
      lastRun: 0, 
      errors: 0,
      interval: this.defaultInterval 
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    log("MetricsScheduler: Starting scheduler");
    this.scheduleNext();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log("MetricsScheduler: Stopped scheduler");
  }

  async scheduleNext() {
    if (!this.running) return;

    try {
      await this.runTasks();
    } catch (error) {
      log.error("MetricsScheduler: Error in scheduler:", error);
    }

    // Schedule next run
    this.timer = setTimeout(() => this.scheduleNext(), this.currentInterval);
  }

  async runTasks() {
    const now = Date.now();
    const promises = [];

    // Run all tasks that are due
    for (const [name, task] of this.tasks) {
      if (now - task.lastRun >= task.interval) {
        promises.push(this.executeTask(name, task));
        task.lastRun = now;
      }
    }

    // Wait for all tasks to complete
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  async executeTask(name, task) {
    try {
      log(`MetricsScheduler: Executing task: ${name}`);
      await task.fn(...task.args);
      task.errors = 0; // Reset error count on success
      
      // Reset interval if it was increased due to errors
      if (task.interval !== this.defaultInterval) {
        task.interval = this.defaultInterval;
        log(`MetricsScheduler: Reset interval for ${name} to ${this.defaultInterval}ms`);
      }
    } catch (error) {
      task.errors++;
      log.error(`MetricsScheduler: Error executing task ${name}:`, error.message);
      
      // Implement exponential backoff on errors
      if (task.errors > 3) {
        task.interval = Math.min(task.interval * 2, 300000); // Max 5 minutes
        log(`MetricsScheduler: Increased interval for ${name} to ${task.interval}ms due to repeated errors`);
      }
      
      // Remove task if too many consecutive errors
      if (task.errors > 10) {
        log.error(`MetricsScheduler: Removing task ${name} due to excessive errors`);
        this.tasks.delete(name);
      }
    }
  }

  getStatus() {
    const status = [];
    for (const [name, task] of this.tasks) {
      status.push({
        name,
        lastRun: new Date(task.lastRun).toISOString(),
        errors: task.errors,
        interval: task.interval
      });
    }
    return status;
  }
}

module.exports = MetricsScheduler;