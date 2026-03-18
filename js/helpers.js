const { makeValidator, cleanEnv, str, host, num, bool } = require("envalid");
const path = require("path");
const axlService = require("cisco-axl");
const perfMonService = require("cisco-perfmon");

// If not production load the local env file
const envFiles = { development: "env/development.env", test: "env/test.env", staging: "env/staging.env" };
const envFile = envFiles[process.env.NODE_ENV];
if (envFile) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", envFile));
  } catch (e) {
    // file doesn't exist, skip
  }
}

const versionValid = makeValidator((x) => {
  if (/.*\..*[^\\]/.test(x)) return x.toUpperCase();
  else throw new Error("CUCM_VERSION must be in the format of ##.#");
});

module.exports = {
  getBaseEnv: cleanEnv(process.env, {
    NODE_ENV: str({
      choices: ["development", "test", "production", "staging"],
      desc: "Node environment",
    }),
    CUCM_HOSTNAME: host({ desc: "Cisco CUCM Hostname or IP Address." }),
    CUCM_USERNAME: str({ desc: "Cisco CUCM AXL Username." }),
    CUCM_PASSWORD: str({ desc: "Cisco CUCM AXL Password." }),
    CUCM_VERSION: versionValid({ desc: "Cisco CUCM Version.", example: "12.5" }),
    INFLUXDB_TOKEN: str({ desc: "InfluxDB API token." }),
    INFLUXDB_ORG: str({ desc: "InfluxDB organization id." }),
    INFLUXDB_BUCKET: str({ desc: "InfluxDB bucket to save data to." }),
    INFLUXDB_URL: str({ desc: "URL of InfluxDB. i.e. http://hostname:8086." }),
    SERVERS: str({
      default: null,
      desc: "Comma separated string of servers to collect data from. If not provided, it will get the servers from AXL.",
    }),
    SERVER_CONCURRENCY: num({
      default: 1,
      desc: "How many servers to query at once. Decrease if you are getting rate limited or 503 errors.",
    }),
    RETRY_FLAG: bool({ default: true, desc: "Flag to retry failed queries." }),
    RETRY: num({
      default: 3,
      desc: "How many times to retry a failed query. Default is 3.",
    }),
    RETRY_DELAY: num({
      default: 15000,
      desc: "How long to wait between retries. Default is 15 seconds.",
    }),
    COOLDOWN_TIMER: num({
      default: 5000,
      desc: "Cool down timer. Time between collecting data for each object.",
    }),
    PERFMON_COUNTERS: str({
      default: null,
      desc: "Comma separated list of perfmon objects to collect via collectCounterData (all counters, all instances, single request per object).",
    }),
    PERFMON_COUNTERS_CONCURRENCY: num({
      default: 1,
      desc: "How many objects to query at once. Decrease if you are getting rate limited or 503 errors.",
    }),
    COUNTER_INTERVAL: num({
      default: 5000,
      desc: "Interval between collectCounterData cycles in milliseconds.",
    }),
    PERFMON_SESSIONS: str({
      default: null,
      desc: "Comma separated list of perfmon objects for session-based percentage counter collection.",
    }),
    PERFMON_SESSIONS_SLEEP: num({
      default: 15000,
      desc: "How long to sleep between baseline and observation samples for percentage counters.",
    }),
    SESSION_INTERVAL: num({
      default: 30000,
      desc: "Interval between session-based collection cycles in milliseconds.",
    }),
    CONFIG_INTERVAL: num({
      default: 30000,
      desc: "Interval between config.json-based collection cycles in milliseconds.",
    }),
    DELAYED_START: num({
      default: null,
      desc: "Delayed start in milliseconds. Useful for staggering multiple containers.",
    }),
  }),
  getServers: async (env) => {
    // AXL Settings
    const settings = {
      version: env.CUCM_VERSION,
      cucmip: env.CUCM_HOSTNAME,
      cucmuser: env.CUCM_USERNAME,
      cucmpass: env.CUCM_PASSWORD,
    };
    var serverArr = (env.SERVERS || "").split(",");
    var servers = {
      callManager: serverArr.map((server) => {
        return { processNodeName: { value: server } };
      }),
    };

    if (!env.SERVERS) {
      var axl_service = new axlService(settings.cucmip, settings.cucmuser, settings.cucmpass, settings.version);
      // Let's get the servers via AXL
      var operation = "listCallManager";
      var tags = await axl_service.getOperationTags(operation);
      tags.searchCriteria.name = "%%";
      servers = await axl_service.executeOperation(operation, tags).catch((error) => {
        console.log(error);
      });
    }
    return servers;
  },
  // counterFilter: optional array of counter names to include e.g. ["CallsActive","CallsCompleted"]
  // When omitted, falls back to percentage-only counters (original behaviour)
  getSessionConfig: async (server, counterArr, counterFilter = null) => {
    const env = module.exports.getBaseEnv;
    return new Promise(async (resolve, reject) => {
      let perfmon_service = new perfMonService(server, env.CUCM_USERNAME, env.CUCM_PASSWORD, { retries: env.RETRY, retryDelay: env.RETRY_DELAY }, env.RETRY_FLAG);
      var objectCollectArr = [];
      var listCounterResults;
      var listInstanceResults;

      try {
        listCounterResults = await perfmon_service.listCounter(server, counterArr);
      } catch (error) {
        console.log(error);
        process.exit(0);
      }

      try {
        for (let i = 0; i < counterArr.length; i++) {
          listInstanceResults = await perfmon_service.listInstance(server, counterArr[i]);
          const findCounter = listCounterResults.results.find((counter) => counter.Name === counterArr[i]);
          let MultiInstance = /true/.test(findCounter?.MultiInstance);

          // Select counters based on filter mode
          const allCounters = findCounter.ArrayOfCounter.item;
          let selectedCounters;
          if (counterFilter && counterFilter.length > 0) {
            // Explicit counter list — match by name (case-insensitive)
            const filterLower = counterFilter.map((c) => c.toLowerCase());
            selectedCounters = allCounters.filter((item) => filterLower.includes(item.Name.toLowerCase()));
          } else {
            // Default: percentage counters only
            selectedCounters = allCounters.filter((item) => item.Name.includes("Percentage") || item.Name.includes("%"));
          }

          const instances = MultiInstance ? listInstanceResults.results : [{ Name: "" }];

          for (const counter of selectedCounters) {
            for (const instance of instances) {
              objectCollectArr.push({
                host: server,
                object: counterArr[i],
                instance: instance.Name,
                counter: counter.Name,
              });
            }
          }
        }
      } catch (error) {
        console.log(error);
        process.exit(0);
      }

      resolve(objectCollectArr);
    });
  }
};
