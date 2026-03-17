const { makeValidator, cleanEnv, str, host, num, bool } = require("envalid");
const path = require("path");
const axlService = require("cisco-axl");
const perfMonService = require("cisco-perfmon");

// If not production load the local env file
if (process.env.NODE_ENV === "development") {
  require("dotenv").config({ path: path.join(__dirname, "..", "env", "development.env") });
} else if (process.env.NODE_ENV === "test") {
  require("dotenv").config({ path: path.join(__dirname, "..", "env", "test.env") });
} else if (process.env.NODE_ENV === "staging") {
  require("dotenv").config({ path: path.join(__dirname, "..", "env", "staging.env") });
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
    PROMETHEUS_PORT: num({
      default: 9090,
      desc: "Port for Prometheus metrics endpoint.",
    }),
    PM_SERVERS: str({
      default: null,
      desc: "Comma separated string of servers to collect data from. If not provided, it will get the servers from AXL.",
    }),
    PM_SERVER_CONCURRENCY: num({
      default: 1,
      desc: "How many servers to query at once. Decrease if you are getting rate limited or 503 errors.",
    }),
    PM_RETRY_FLAG: bool({default: true, desc: "Flag to retry failed queries. Default is false."}),
    PM_RETRY: num({
      default: 3,
      desc: "How many times to retry a failed query. Default is 3.",
    }),
    PM_RETRY_DELAY: num({
      default: 15000,
      desc: "How long to wait between retries. Default is 15 seconds.",
    }),
    PM_COOLDOWN_TIMER: num({
      default: 5000,
      desc: "Cool down timer. Time between collecting data for each object.",
    }),
    PM_OBJECT_COLLECT_ALL: str({
      default: null,
      desc: "Comma separated string of what object to collect. Returns the perfmon data for all counters that belong to an object on a particular host",
    }),
    PM_OBJECT_COLLECT_ALL_CONCURRENCY: num({
      default: 1,
      desc: "How many objects to query at once. Decrease if you are getting rate limited or 503 errors.",
    }),
    PM_INTERVAL: num({
      default: 5000,
      desc: "Interval timer. Time between starting new collection period.",
    }),
    PM_OBJECT_SESSION_PERCENTAGE: str({
      default: null,
      desc: "Comma separated string of what counters to query. These are percentage counters that two or more samples to collect data.",
    }),
    PM_OBJECT_SESSION_PERCENTAGE_SLEEP: num({
      default: 15000,
      desc: "How long to sleep between adding objects to a session and collecting data. This is for percentage counters that need time to collect data.",
    }),
    PM_DELAYED_START: num({
      default: null,
      desc: "Delay start of collection by this many milliseconds.",
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
    var serverArr = (env.PM_SERVERS || "").split(",");
    var servers = {
      callManager: serverArr.map((server) => {
        return { processNodeName: { value: server } };
      }),
    };

    if (!env.PM_SERVERS) {
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
  getSessionConfig: async (serverName, objectArray) => {
    var perfmon_service = new perfMonService(serverName, process.env.CUCM_USERNAME, process.env.CUCM_PASSWORD);
    let objectCollectArr = [];

    var listCounterResults = await perfmon_service.listCounter(serverName, objectArray);
    for (let i = 0; i < objectArray.length; i++) {
      var listInstanceResults = await perfmon_service.listInstance(serverName, objectArray[i]);
      const findCounter = listCounterResults.results.find((counter) => counter.Name === objectArray[i]);
      let MultiInstanceVal = findCounter?.MultiInstance;
      let MultiInstance = /true/.test(MultiInstanceVal);
      let locateCounter = findCounter.ArrayOfCounter.item;

      // Loop through the list of instances and counters
      for (let j = 0; j < locateCounter.length; j++) {
        for (let k = 0; k < listInstanceResults.results.length; k++) {
          var collectSessionObj = {
            host: serverName,
            object: "",
            instance: "",
            counter: "",
          };
          collectSessionObj.object = objectArray[i];
          collectSessionObj.instance = MultiInstance ? listInstanceResults.results[k].Name : "";
          collectSessionObj.counter = locateCounter[j].Name;
          objectCollectArr.push(collectSessionObj);
        }
      }
    }
    return objectCollectArr;
  },
};