const express = require("express");
const log = require("fancy-log");
const path = require("path");

// Import our modules
const MetricsRegistry = require("./metrics/MetricsRegistry");
const MetricsScheduler = require("./schedulers/MetricsScheduler");
const CounterCollector = require("./collectors/CounterCollector");
const SessionCollector = require("./collectors/SessionCollector");
const ConfigCollector = require("./collectors/ConfigCollector");
const FileUtils = require("./utils/FileUtils");

class PrometheusExporter {
  constructor(env, sessionSSO) {
    this.env = env;
    this.sessionSSO = sessionSSO;
    this.port = env.PROMETHEUS_PORT || 9090;
    this.interval = parseInt(env.PM_INTERVAL);
    
    // Initialize components
    this.metricsRegistry = new MetricsRegistry();
    this.scheduler = new MetricsScheduler(this.interval);
    
    // Initialize collectors
    this.counterCollector = new CounterCollector(env, sessionSSO, this.metricsRegistry);
    this.sessionCollector = new SessionCollector(env, sessionSSO, this.metricsRegistry);
    this.configCollector = new ConfigCollector(env, sessionSSO, this.metricsRegistry);
    
    // Setup Express app
    this.app = express();
    this.setupRoutes();
  }

  setupRoutes() {
    // Metrics endpoint for Prometheus
    this.app.get('/metrics', async (req, res) => {
      try {
        res.set('Content-Type', this.metricsRegistry.contentType);
        const metrics = await this.metricsRegistry.getMetrics();
        res.end(metrics);
      } catch (error) {
        res.status(500).end(error);
      }
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'healthy',
        uptime: process.uptime(),
        tasks: this.scheduler.getStatus()
      });
    });

    // Status endpoint
    this.app.get('/status', (req, res) => {
      res.json({
        scheduler: {
          running: this.scheduler.running,
          tasks: this.scheduler.getStatus()
        },
        metrics: {
          count: Object.keys(this.metricsRegistry.metrics).length
        }
      });
    });
  }

  async start() {
    // Start HTTP server
    this.server = this.app.listen(this.port, () => {
      log(`Prometheus metrics server listening on port ${this.port}`);
      log(`Metrics available at http://localhost:${this.port}/metrics`);
      log(`Health check at http://localhost:${this.port}/health`);
      log(`Status at http://localhost:${this.port}/status`);
    });

    // Delayed start if configured
    if (this.env.PM_DELAYED_START) {
      log("Delaying start for", this.env.PM_DELAYED_START / 1000, "seconds.");
      await FileUtils.delay(this.env.PM_DELAYED_START);
    }

    // Setup graceful shutdown
    this.setupGracefulShutdown();
  }

  async setupTasks(servers) {
    // Add config-based collection if available
    const configData = await FileUtils.checkAndRead(path.join(__dirname, "..", "..", "data", "config.json"));
    if (configData) {
      this.scheduler.addTask(
        'config', 
        (...args) => this.configCollector.collect(...args), 
        [configData, "PERFMON SESSION CONFIG"]
      );
    }

    // Add counter collection if configured
    if (this.env.PM_OBJECT_COLLECT_ALL) {
      this.scheduler.addTask(
        'counter', 
        (...args) => this.counterCollector.collect(...args), 
        [servers, "PERFMON COUNTER DATA"]
      );
    } else {
      log("PM_OBJECT_COLLECT_ALL env variable not set. Skipping collection.");
    }

    // Add session collection if configured
    if (this.env.PM_OBJECT_SESSION_PERCENTAGE) {
      this.scheduler.addTask(
        'session', 
        (...args) => this.sessionCollector.collect(...args), 
        [servers, "PERFMON SESSION DATA"]
      );
    } else {
      log("PM_OBJECT_SESSION_PERCENTAGE env variable not set. Skipping collection.");
    }

    // Start scheduler if we have tasks
    if (this.scheduler.tasks.size > 0) {
      await this.scheduler.start();
      log("Metrics collection scheduler started");
      return true;
    } else {
      log("No tasks to execute found.");
      return false;
    }
  }

  setupGracefulShutdown() {
    const shutdown = (signal) => {
      log(`Received ${signal}. Shutting down gracefully...`);
      
      // Stop scheduler
      this.scheduler.stop();
      
      // Close HTTP server
      if (this.server) {
        this.server.close(() => {
          log('HTTP server closed');
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  stop() {
    this.scheduler.stop();
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = PrometheusExporter;