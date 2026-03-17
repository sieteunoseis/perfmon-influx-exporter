const { Command } = require("commander");
const { getBaseEnv, getServers, getSessionConfig } = require("./js/helpers-prometheus");
const validator = require("validator");
const log = require("fancy-log");
const path = require("path");
const fs = require("fs").promises;

// Import our Prometheus exporter
const PrometheusExporter = require("./src/prometheus/PrometheusExporter");
const sessionSSO = require("./js/sessionSSO");
const FileUtils = require("./src/prometheus/utils/FileUtils");

const env = getBaseEnv;
const program = new Command();

function validateFQDN(value) {
  if (validator.isFQDN(value) || validator.isIP(value)) {
    return value;
  } else {
    throw new commander.InvalidOptionArgumentError("Invalid FQDN/IP Address format");
  }
}

(async () => {
  program
    .name('perfmon-prometheus-exporter')
    .description('Cisco Perfmon Prometheus Exporter')
    .version('1.0.0');

  program
    .command("config")
    .description("download config file")
    .requiredOption("-s,--server <fqdn>", "Fully qualified domain name or IP Address.", validateFQDN)
    .requiredOption("-o, --objects <objects>", "Comma separated list of objects.", FileUtils.commaSeparatedList)
    .action(async (options) => {
      try {
        const config = await getSessionConfig(options.server, options.objects);
        // Convert JSON object to string
        const jsonString = JSON.stringify(config, null, 2);
        
        // Get the current date
        const currentDate = new Date();
        const formattedDate = currentDate.toISOString().slice(0, 10);
        
        // Create a filename with the formatted date
        const filename = `config.${formattedDate}.json`;
        const filePath = path.join(__dirname, "data", filename);
        
        await fs.writeFile(filePath, jsonString);
        log(`PERFMON SESSION CONFIG: ${filename} successfully saved to ${filePath}`);
      } catch (err) {
        log.error("Error:", err);
        process.exit(1);
      }
    });

  program
    .command("start", { isDefault: true })
    .description("Run the Prometheus exporter")
    .action(async () => {
      try {
        // Initialize the Prometheus exporter
        const exporter = new PrometheusExporter(env, sessionSSO);
        
        // Start the HTTP server
        await exporter.start();

        // Get servers from AXL API or ENV
        let servers;
        try {
          servers = await getServers(env);
          log(`Found ${servers.callManager.length} server(s) in the cluster`);
        } catch (error) {
          log.error("Failed to get servers:", error);
          process.exit(1);
        }

        // Setup and start collection tasks
        const hassTasks = await exporter.setupTasks(servers);
        if (!hassTasks) {
          log("No tasks configured. Exiting.");
          process.exit(1);
        }

        log("Prometheus exporter started successfully");
        log("Press Ctrl+C to stop");

      } catch (error) {
        log.error("Failed to start exporter:", error);
        process.exit(1);
      }
    });

  program
    .command("test")
    .description("Test configuration and connectivity")
    .action(async () => {
      try {
        log("Testing configuration...");
        
        // Test environment variables
        log("Environment check:", {
          CUCM_HOSTNAME: env.CUCM_HOSTNAME,
          PROMETHEUS_PORT: env.PROMETHEUS_PORT,
          PM_INTERVAL: env.PM_INTERVAL,
          PM_OBJECT_COLLECT_ALL: !!env.PM_OBJECT_COLLECT_ALL,
          PM_OBJECT_SESSION_PERCENTAGE: !!env.PM_OBJECT_SESSION_PERCENTAGE
        });

        // Test server connectivity
        const servers = await getServers(env);
        log(`✓ Successfully connected to CUCM and found ${servers.callManager.length} server(s)`);
        
        servers.callManager.forEach((server, index) => {
          log(`  ${index + 1}. ${server.processNodeName.value}`);
        });

        // Test config file if exists
        const configPath = path.join(__dirname, "data", "config.json");
        const configData = await FileUtils.checkAndRead(configPath);
        if (configData) {
          const parsedConfig = JSON.parse(configData);
          log(`✓ Found config file with ${parsedConfig.length} objects`);
        } else {
          log("ℹ No config.json file found (optional)");
        }

        log("✓ Configuration test completed successfully");
        
      } catch (error) {
        log.error("✗ Configuration test failed:", error);
        process.exit(1);
      }
    });

  program.parse(process.argv);
})();