const log = require("fancy-log");
const pLimit = require("p-limit");
const perfMonService = require("cisco-perfmon");

class CounterCollector {
  constructor(env, sessionSSO, metricsRegistry) {
    this.env = env;
    this.sessionSSO = sessionSSO;
    this.metricsRegistry = metricsRegistry;
    this.serverLimit = pLimit(env.PM_SERVER_CONCURRENCY);
    this.objectLimit = pLimit(env.PM_OBJECT_COLLECT_ALL_CONCURRENCY);
    this.rateControl = false;
  }

  async collect(servers, logPrefix) {
    const perfmonObjectArr = this.env.PM_OBJECT_COLLECT_ALL.split(",");
    log(`${logPrefix}: Found ${servers.callManager.length} server(s) in the cluster. Starting collection for each server, up to ${this.env.PM_SERVER_CONCURRENCY} at a time, if applicable.`);

    const serverPromises = servers.callManager.map(server => 
      this.serverLimit(() => this.collectFromServer(server, perfmonObjectArr, logPrefix))
    );

    try {
      const results = await Promise.all(serverPromises);
      this.logResults(results, logPrefix);
    } catch (error) {
      log.error(error);
      throw error;
    }

    if (this.rateControl) {
      this.rateControl = false;
      throw new Error("RateControl detected.");
    }
  }

  async collectFromServer(server, perfmonObjectArr, logPrefix) {
    const serverName = server.processNodeName.value;
    const jsonResults = {
      server: serverName,
      authMethod: { basic: 0, sso: 0 },
      results: {},
      cooldownTimer: this.env.PM_COOLDOWN_TIMER / 1000 + " second(s)",
      intervalTimer: this.env.PM_INTERVAL / 1000 + " second(s)",
    };

    log(`${logPrefix}: Collecting data for ${serverName}.`);

    // Set up perfmon service with authentication
    let perfmon_service = await this.setupPerfmonService(serverName, jsonResults);

    log(`${logPrefix}: Found ${perfmonObjectArr.length} object(s) to collect on ${serverName}. Collecting ${this.env.PM_OBJECT_COLLECT_ALL_CONCURRENCY} objects at a time.`);

    // Collect data from all objects
    const output = await this.collectAllObjects(perfmon_service, serverName, perfmonObjectArr, jsonResults);

    // Process and update metrics
    this.processMetrics(output, jsonResults);

    return jsonResults;
  }

  async setupPerfmonService(serverName, jsonResults) {
    let perfmon_service = new perfMonService(
      serverName, 
      this.env.CUCM_USERNAME, 
      this.env.CUCM_PASSWORD, 
      {}, 
      this.env.PM_RETRY_FLAG
    );

    const ssoArr = this.sessionSSO.getSSOArray();
    const ssoIndex = ssoArr.findIndex((element) => element.name === serverName);
    
    if (ssoIndex !== -1) {
      perfmon_service = new perfMonService(
        serverName, 
        "", 
        "", 
        { cookie: ssoArr[ssoIndex].cookie }, 
        this.env.PM_RETRY_FLAG
      );
    } else {
      jsonResults.authMethod.basic++;
      const listCounterResults = await perfmon_service.listCounter(serverName);
      if (listCounterResults.cookie) {
        this.sessionSSO.updateSSO(serverName, { cookie: listCounterResults.cookie });
      }
    }

    return perfmon_service;
  }

  async collectAllObjects(perfmon_service, serverName, perfmonObjectArr, jsonResults) {
    const ssoArr = this.sessionSSO.getSSOArray();
    const objectSSOIndex = ssoArr.findIndex((element) => element.name === serverName);

    const promises = perfmonObjectArr.map((object) => {
      if (objectSSOIndex !== -1) {
        jsonResults.authMethod.sso++;
      }
      return this.objectLimit(() => 
        this.retry(
          () => perfmon_service.collectCounterData(serverName, object), 
          this.env.PM_RETRY, 
          this.env.PM_RETRY_DELAY, 
          this.env.PM_COOLDOWN_TIMER
        )
      );
    });

    let output = await Promise.allSettled(promises);
    return output.map((el) => el.status === "fulfilled" ? el.value : el.reason).flat(1);
  }

  processMetrics(output, jsonResults) {
    // Filter out percentage counters
    const nonPercentageObjects = output.reduce((acc, obj) => {
      if (obj?.results && obj?.results?.length > 0) {
        const matchingItems = obj.results.filter(
          (item) => !item?.counter.includes("%") && !item.counter?.includes("Percentage")
        );
        if (matchingItems.length > 0) {
          acc.push(matchingItems);
        }
        return acc.flat(1);
      }
      return acc;
    }, []);

    // Update Prometheus metrics
    this.metricsRegistry.updateMetrics(nonPercentageObjects);

    // Build results summary
    let success = {};
    let returnResults = [];

    output.forEach((el) => {
      if (el?.status > 400) {
        this.rateControl = true;
        returnResults.push({ object: el.object, count: -1 });
      } else if (el?.results && el?.results?.length > 0) {
        el.results.forEach((result) => {
          let count = (success[result.object] || 0) + 1;
          success[result.object] = count;
        });
        returnResults.push({ 
          object: el.object, 
          count: success[el.object] ? success[el.object] : -1 
        });
      }
    });

    jsonResults.results = returnResults;
    log(`CounterCollector: Updated ${nonPercentageObjects.length} metrics for ${jsonResults.server}.`);
  }

  async retry(fn, retriesLeft, retryInterval, promiseDelay) {
    return new Promise(async (resolve, reject) => {
      await new Promise((resolve) => setTimeout(resolve, promiseDelay));
      fn()
        .then(resolve)
        .catch((error) => {
          if (retriesLeft > 0) {
            setTimeout(() => {
              this.retry(fn, retriesLeft - 1, retryInterval, promiseDelay)
                .then(resolve, reject);
            }, retryInterval);
          } else {
            reject(error);
          }
        });
    });
  }

  logResults(results, logPrefix) {
    log(`${logPrefix} RESULTS:`);
    for (const result of results) {
      const table = result.results;
      const authTable = result.authMethod;
      delete result.authMethod;
      delete result.results;
      console.table(result);
      log(`${logPrefix} Auth Counts:`);
      console.table(authTable);
      log(`${logPrefix} Object Results:`);
      console.table(table);
    }
  }
}

module.exports = CounterCollector;