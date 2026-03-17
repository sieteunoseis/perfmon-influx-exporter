# Perfmon Prometheus Exporter

A modular Cisco Perfmon exporter that exposes metrics in Prometheus format. This replaces the InfluxDB push model with Prometheus's pull model for better monitoring integration.

## Quick Start

```bash
# Clone and install
git clone <repo-url>
cd perfmon-influx-exporter-1
npm install

# Configure environment
cp env.prometheus.example .env
# Edit .env with your CUCM details

# Run (Docker recommended)
npm run docker:build:prometheus
cd docker/prometheus
docker-compose up -d

# Or run natively
npm run start:prometheus
```

## Architecture

```
src/prometheus/
├── PrometheusExporter.js           # Main orchestrator
├── schedulers/MetricsScheduler.js  # Smart task scheduling  
├── metrics/MetricsRegistry.js      # Prometheus metrics management
├── collectors/                     # Data collection modules
│   ├── CounterCollector.js         # Direct counter collection
│   ├── SessionCollector.js         # Session-based percentage counters
│   └── ConfigCollector.js          # Config file-based collection
└── utils/FileUtils.js              # Utility functions

docker/prometheus/                   # Complete monitoring stack
```

## Configuration

### Environment Variables

```bash
# Required
CUCM_HOSTNAME=your-cucm-server.com
CUCM_USERNAME=admin
CUCM_PASSWORD=password
CUCM_VERSION=14.0

# Optional
PROMETHEUS_PORT=9090
PM_INTERVAL=30000
PM_COOLDOWN_TIMER=3000
PM_RETRY=3
PM_SERVER_CONCURRENCY=2

# What to collect
PM_OBJECT_COLLECT_ALL=Memory,Processor,System
PM_OBJECT_SESSION_PERCENTAGE=Memory,Processor,Process,Partition,Thread
```

## Running Options

### 1. Docker (Recommended)

Complete monitoring stack with Prometheus and Grafana:

```bash
npm run docker:build:prometheus
cd docker/prometheus
docker-compose up -d
```

Access:
- Exporter: http://localhost:9090/metrics
- Prometheus: http://localhost:9091
- Grafana: http://localhost:3000 (admin/admin)

### 2. Native Node.js

```bash
# Development
npm run development:prometheus

# Production
npm run start:prometheus

# Test configuration
npm run test:prometheus
```

### 3. Systemd Service (Linux)

```bash
# Setup service
sudo cp systemd/perfmon-prometheus.service /etc/systemd/system/
sudo systemctl enable perfmon-prometheus
sudo systemctl start perfmon-prometheus
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/metrics` | Prometheus metrics |
| `/health` | Health check with task status |
| `/status` | Detailed scheduler information |

### Health Check Response
```json
{
  "status": "healthy",
  "uptime": 1234.56,
  "tasks": [
    {
      "name": "counter",
      "lastRun": "2024-01-01T12:00:00.000Z",
      "errors": 0,
      "interval": 30000
    }
  ]
}
```

## Commands

```bash
# Start exporter
node main-prometheus-modular.js start

# Test configuration  
node main-prometheus-modular.js test

# Generate config file
node main-prometheus-modular.js config -s server.com -o "Memory,Processor"
```

## Prometheus Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'perfmon'
    scrape_interval: 30s
    static_configs:
      - targets: ['localhost:9090']
        labels:
          environment: 'production'
          service: 'cisco-perfmon'
```

## Key Features

### Smart Scheduling
- Event-driven (no recursive loops)
- Exponential backoff on errors
- Automatic failed task removal
- Memory efficient

### Modular Design
- Single responsibility per module
- Easy to test and extend
- Clean separation of concerns
- Type-safe interfaces

### Production Ready
- Built-in health checks
- Comprehensive error handling
- Graceful shutdown
- Docker optimized

## Metrics Format

Metrics follow Prometheus naming conventions:

```
perfmon_cisco_callmanager_registeredphones{host="cucm-pub.example.com",cstatus="1",instance=""} 42
perfmon_memory_percentmemoryinuse{host="cucm-pub.example.com",cstatus="1",instance=""} 67.5
```

## Process Management

**Do you need PM2?** Generally **NO** for Prometheus exporters.

| Method | Best For | Auto-restart | Monitoring |
|--------|----------|--------------|------------|
| **Docker** | Production | ✅ | Built-in |
| **Systemd** | Linux servers | ✅ | journald |
| **Native** | Development | ❌ | Manual |
| **PM2** | Multi-service | ✅ | PM2 dashboard |

Docker is recommended for most production scenarios.

## Troubleshooting

### Test Configuration
```bash
npm run test:prometheus
```

### Check Status
```bash
curl http://localhost:9090/status
```

### View Health
```bash
curl http://localhost:9090/health
```

### Common Issues

1. **Connection refused**: Check CUCM credentials and network access
2. **Rate limiting**: Reduce PM_SERVER_CONCURRENCY or increase PM_INTERVAL
3. **No metrics**: Verify PM_OBJECT_* environment variables are set

## Migration from InfluxDB

Key differences:
- **Pull model**: Prometheus scrapes metrics instead of pushing
- **HTTP endpoint**: Metrics exposed at `/metrics`
- **Format**: Prometheus exposition format vs InfluxDB line protocol
- **Storage**: Metrics stored in Prometheus, not separate database

The same data collection logic is maintained for compatibility.

## Contributing

1. Follow the modular architecture
2. Add new collectors in `src/prometheus/collectors/`
3. Extend schedulers in `src/prometheus/schedulers/`
4. Update tests and documentation

## License

MIT