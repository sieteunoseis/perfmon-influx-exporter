# Perfmon InfluxDB Exporter

NodeJS application using Cisco Perfmon API to export data to InfluxDB. There are three collection methods:

1. **Session Config** (`config.json`) — Collects specific counters and instances defined in a static config file. Most efficient: 5 SOAP calls per cycle regardless of counter count. Recommended for all known/static devices (CallManager, MGCP, MOH, MTP, HW Conf Bridge, TFTP, etc).
2. **Counter Data** (`PERFMON_COUNTERS`) — Collects all counters for a given object across all instances in a single request per object per server. Best for dynamic objects where instances change frequently, such as `Cisco SIP` (new trunks added without regenerating config).
3. **Session Data** (`PERFMON_SESSIONS`) — Session-based collection that takes a baseline and observation sample to compute delta/percentage values. Required for counters that are cumulative by nature (e.g. `% CPU Time`, `% Mem Used`).

If a method is not configured, it is skipped. At least one method must be configured or the application will exit.

## Performance

Using `config.json` dramatically reduces SOAP calls to CUCM compared to polling every object on every server via `PERFMON_COUNTERS`.

| Method | SOAP calls/cycle |
| --- | --- |
| `PERFMON_COUNTERS` | objects × servers (e.g. 88 objects × 6 servers = 528 calls) |
| `config.json` (Session Config) | **5** — regardless of counter or server count |
| `PERFMON_SESSIONS` | ~13 calls × servers |

The `config.json` approach scales to any cluster size with no increase in SOAP calls. `PERFMON_COUNTERS` grows linearly with both object count and server count, and each call is followed by `COOLDOWN_TIMER`, making full-cycle times impractical for large object lists.

**Recommended approach:**

- Put all known static devices in `config.json` — 5 SOAP calls covers everything regardless of how many counters
- Use `PERFMON_COUNTERS` only for objects with frequently changing instances (e.g. `Cisco SIP` — new trunks are discovered automatically each cycle without regenerating config)
- Use `PERFMON_SESSIONS` for delta/percentage counters that require baseline→observation sampling

Regenerate `config.json` when hardware changes (new gateways, conference bridges, MGCP spans, etc).

## Features

- Collects Perfmon data from CUCM and exports to InfluxDB
- Docker container with `tini` for proper PID 1 signal handling and graceful shutdown
- `config.json` generator — discovers instances dynamically across multiple servers and writes a static config file
- Independent collection loops with shared rate-limit backoff
- Configurable intervals per collection method
- Graceful SIGTERM/SIGINT shutdown — waits for in-flight requests to complete

## Running via Docker

```bash
mkdir /docker/perfmon && cd /docker/perfmon
touch docker-compose.yml
touch .env
docker compose up -d
```

### docker-compose.yml

```yaml
services:
  perfmon:
    image: ghcr.io/sieteunoseis/perfmon-influx-exporter:latest
    command:
      - start
    restart: always
    volumes:
      - ./data:/usr/src/app/data
    env_file:
      - .env
```

#### Generating config.json

The `config` command queries CUCM to discover instances for the specified objects and writes a static `config.json`. Run this once to build your config, then re-run when devices change (new gateways, conference bridges, etc).

```bash
# Single server
docker run --rm -v $(pwd)/data:/usr/src/app/data --env-file=.env \
  ghcr.io/sieteunoseis/perfmon-influx-exporter:latest \
  config -s "hq-cucm-pub.abc.inc" \
  -o "Cisco CallManager,Cisco HW Conference Bridge Device,Cisco MGCP PRI Device,Cisco MOH Device,Cisco MTP Device,Cisco TFTP,Memory,Processor" \
  --counters "CallsActive,CallsCompleted,HWConferenceActive,RegisteredHardwarePhones,RegisteredOtherStationDevices,MOHMulticastResourceActive,MOHUnicastResourceActive,MTPResourceActive,ResourceActive,HWConferenceCompleted,Requests,HttpRequests,% Mem Used,% CPU Time"

# Multiple servers (comma-separated)
docker run --rm -v $(pwd)/data:/usr/src/app/data --env-file=.env \
  ghcr.io/sieteunoseis/perfmon-influx-exporter:latest \
  config -s "pub.example.com,sub1.example.com,sub2.example.com" \
  -o "Cisco CallManager,Cisco MGCP PRI Device,Memory,Processor" \
  --counters "CallsActive,CallsCompleted,RegisteredHardwarePhones,% Mem Used,% CPU Time"
```

The generated file is saved to `data/config.YYYY-MM-DD.json`. Rename or copy to `data/config.json` to activate it.

When `--counters` is omitted, only percentage counters (`%` or `Percentage` in name) are included.

## Environment Variables

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | string | production | Node environment (`development`, `production`, `staging`, `test`) |
| `CUCM_HOSTNAME` | FQDN or IP | required | CUCM publisher hostname or IP address |
| `CUCM_USERNAME` | string | required | CUCM AXL username |
| `CUCM_PASSWORD` | string | required | CUCM AXL password |
| `CUCM_VERSION` | string | required | CUCM version, e.g. `15.0` |
| `INFLUXDB_TOKEN` | string | required | InfluxDB API token |
| `INFLUXDB_ORG` | string | required | InfluxDB organization ID |
| `INFLUXDB_BUCKET` | string | required | InfluxDB bucket name |
| `INFLUXDB_URL` | URL | required | InfluxDB URL, e.g. `http://hostname:8086` |
| `SERVERS` | string | null | Comma-separated list of servers to poll. If blank, servers are discovered via AXL. |
| `SERVER_CONCURRENCY` | int | 1 | Number of servers to query in parallel. Reduce if rate limited. |
| `RETRY_FLAG` | bool | true | Enable retry on failed requests |
| `RETRY` | int | 3 | Number of retries on failure |
| `RETRY_DELAY` | ms | 15000 | Delay between retries |
| `COOLDOWN_TIMER` | ms | 5000 | Delay between object queries within `collectCounterData` |
| `DELAYED_START` | ms | null | Delay before starting collection. Useful for staggering containers. |
| `PERFMON_COUNTERS` | string | null | Comma-separated list of objects for `collectCounterData` (all counters, all instances, one request per object). Best for dynamic objects like `Cisco SIP`. |
| `PERFMON_COUNTERS_CONCURRENCY` | int | 1 | Number of objects to query in parallel within `collectCounterData`. |
| `COUNTER_INTERVAL` | ms | 5000 | Interval between `collectCounterData` cycles |
| `PERFMON_SESSIONS` | string | null | Comma-separated list of objects for session-based delta collection. Use for objects with cumulative counters requiring baseline→observation sampling (e.g. `Memory,Processor,Process,Partition,Thread`). |
| `PERFMON_SESSIONS_SLEEP` | ms | 15000 | Sleep between baseline and observation samples |
| `SESSION_INTERVAL` | ms | 30000 | Interval between `collectSessionData` cycles |
| `CONFIG_INTERVAL` | ms | 30000 | Interval between `collectSessionConfig` (config.json) cycles |

**Note: Do not use quotes in the `.env` file.**

## Example .env

```env
NODE_ENV=production
CUCM_HOSTNAME=hq-cucm-pub.abc.inc
CUCM_USERNAME=perfmon
CUCM_PASSWORD=yourpassword
CUCM_VERSION=15.0

INFLUXDB_TOKEN=your-token
INFLUXDB_ORG=your-org-id
INFLUXDB_BUCKET=cisco_perfmon
INFLUXDB_URL=http://influxdb:8086

COOLDOWN_TIMER=3000
COUNTER_INTERVAL=5000
SESSION_INTERVAL=30000
CONFIG_INTERVAL=30000

# Dynamic objects — instances auto-discovered each cycle
PERFMON_COUNTERS=Cisco SIP

# Delta/percentage counters — require baseline→observation sampling
PERFMON_SESSIONS=Memory,Processor,Process,Partition,Thread
```

## Perfmon Objects

Full list of available Perfmon objects as of CUCM 15.0. Remove objects for features not in use.

Reference: [CUCM 15 Performance Counters and Alerts](https://www.cisco.com/c/en/us/td/docs/voice_ip_comm/cucm/service/15/rtmt/cucm_b_cisco-unified-rtmt-administration-15/cucm_m_performance-counters-and-alerts-15.html)

```
Cisco Analog Access
Cisco Annunciator Device
Cisco AXL Tomcat Connector
Cisco AXL Tomcat JVM
Cisco AXL Tomcat Web Application
Cisco AXL Web Service
Cisco Call Restriction
Cisco CallManager
Cisco CallManager System Performance
Cisco CAR DB
Cisco CTI Manager
Cisco CTI Proxy
Cisco Device Activation
Cisco Dual-Mode Mobility
Cisco Extension Mobility
Cisco Gatekeeper
Cisco H323
Cisco HAProxy
Cisco Hunt Lists
Cisco Hunt Pilots
Cisco HW Conference Bridge Device
Cisco IP Manager Assistant
Cisco IVR Device
Cisco LBM Service
Cisco LDAP Directory
Cisco Lines
Cisco Locations LBM
Cisco Locations RSVP
Cisco Media Streaming App
Cisco MGCP BRI Device
Cisco MGCP FXO Device
Cisco MGCP FXS Device
Cisco MGCP Gateways
Cisco MGCP PRI Device
Cisco MGCP T1CAS Device
Cisco Mobility Manager
Cisco MOH Device
Cisco MTP Device
Cisco Phones
Cisco Presence Features
Cisco QSIG Features
Cisco Recording
Cisco SAF Client
Cisco Signaling
Cisco SIP
Cisco SIP Line Normalization
Cisco SIP Normalization
Cisco SIP Stack
Cisco SIP Station
Cisco SSOSP Tomcat Connector
Cisco SSOSP Tomcat JVM
Cisco SSOSP Tomcat Web Application
Cisco SW Conference Bridge Device
Cisco Telepresence MCU Conference Bridge Device
Cisco TFTP
Cisco Tomcat Connector
Cisco Tomcat JVM
Cisco Tomcat Web Application
Cisco Transcode Device
Cisco UDS Tomcat Connector
Cisco UDS Tomcat JVM
Cisco UDS Tomcat Web Application
Cisco Video Conference Bridge Device
Cisco Video On Hold Device
Cisco WebDialer
Cisco WSMConnector
DB Change Notification Client
DB Change Notification Server
DB Change Notification Subscriptions
DB Local_DSN
DB User Host Information Counters
Docker Container
Enterprise Replication DBSpace Monitors
Enterprise Replication Perfmon Counters
External Call Control
IME Client
IME Client Instance
IP
IP6
Memory
Network Interface
Number of Replicates Created and State of Replication
Partition
Process
Processor
Ramfs
SAML SSO
System
TCP
Thread
```

## Troubleshooting

### Verify data via CUCM CLI

```shell
show perf query counter "Cisco CallManager" "CallsActive"
```

### Rate Limiting

If you see errors like:

```
Exceeded allowed rate for Perfmon information. Current allowed rate for perfmon information is 80 requests per minute.
```

Increase the limit under CUCM Enterprise Parameters → Rate Control → Allowed Device Queries Per Minute. Also consider reducing `SERVER_CONCURRENCY` or `PERFMON_COUNTERS_CONCURRENCY`.

### CUCM Log Files

```shell
file list activelog /tomcat/logs/soap/csv/ratecontrol*.csv page detail date reverse
file view activelog /tomcat/logs/soap/csv/ratecontrol*.csv

file list activelog /tomcat/logs/soap/log4j/soap*.log page detail date reverse
file view activelog /tomcat/logs/soap/log4j/soap*.log
```

### Certificate Errors

```env
NODE_NO_WARNINGS=1
NODE_TLS_REJECT_UNAUTHORIZED=0
```

## Giving Back

If you would like to support my work and the time I put in creating the code, you can click the image below to get me a coffee. I would really appreciate it (but is not required).

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/black_img.png)](https://www.buymeacoffee.com/automatebldrs)

-Jeremy Worden

Enjoy!
