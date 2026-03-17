const client = require("prom-client");

class MetricsRegistry {
  constructor() {
    this.register = new client.Registry();
    this.metrics = {};
    
    // Add default metrics (optional)
    client.collectDefaultMetrics({ register: this.register });
  }

  /**
   * Create or get a metric
   * @param {string} object - The object name
   * @param {string} counter - The counter name
   * @returns {client.Gauge} The Prometheus gauge metric
   */
  getOrCreateMetric(object, counter) {
    const metricName = `perfmon_${object.replace(/[^a-zA-Z0-9]/g, '_')}_${counter.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase();
    
    if (!this.metrics[metricName]) {
      this.metrics[metricName] = new client.Gauge({
        name: metricName,
        help: `Perfmon metric for ${object} - ${counter}`,
        labelNames: ['host', 'cstatus', 'instance'],
        registers: [this.register]
      });
    }
    
    return this.metrics[metricName];
  }

  /**
   * Update a metric value
   * @param {Object} data - The metric data
   */
  updateMetric(data) {
    const metric = this.getOrCreateMetric(data.object, data.counter);
    metric.set(
      {
        host: data.host,
        cstatus: data.cstatus,
        instance: data.instance
      },
      parseFloat(data.value)
    );
  }

  /**
   * Update multiple metrics
   * @param {Array} dataArray - Array of metric data
   */
  updateMetrics(dataArray) {
    dataArray.forEach(data => this.updateMetric(data));
  }

  /**
   * Get metrics in Prometheus format
   * @returns {Promise<string>} Metrics in Prometheus exposition format
   */
  async getMetrics() {
    return this.register.metrics();
  }

  /**
   * Get content type for Prometheus metrics
   * @returns {string} Content type
   */
  get contentType() {
    return this.register.contentType;
  }

  /**
   * Clear all metrics
   */
  clear() {
    this.register.clear();
    this.metrics = {};
  }
}

module.exports = MetricsRegistry;