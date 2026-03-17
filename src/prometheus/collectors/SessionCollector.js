const log = require("fancy-log");
const pLimit = require("p-limit");
const perfMonService = require("cisco-perfmon");

class SessionCollector {
  constructor(env, sessionSSO, metricsRegistry) {
    this.env = env;
    this.sessionSSO = sessionSSO;
    this.metricsRegistry = metricsRegistry;
    this.serverLimit = pLimit(env.PM_SERVER_CONCURRENCY);
    this.rateControl = false;
  }

  async collect(servers, logPrefix) {
    const perfmonSessionArr = this.env.PM_OBJECT_SESSION_PERCENTAGE.split(",");
    log(`${logPrefix}: Found ${servers.callManager.length} server(s) in the cluster. Starting collection for each server, up to ${this.env.PM_SERVER_CONCURRENCY} at a time, if applicable.`);
    
    const serverPromises = servers.callManager.map(server => 
      this.serverLimit(() => this.collectFromServer(server, perfmonSessionArr, logPrefix))
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

  async collectFromServer(server, perfmonSessionArr, logPrefix) {
    const serverName = server.processNodeName.value;
    const jsonResults = {
      server: serverName,
      authMethod: { basic: 0, sso: 0 },
      results: [],
      cooldownTimer: this.env.PM_COOLDOWN_TIMER / 1000 + " second(s)",
      intervalTimer: this.env.PM_INTERVAL / 1000 + " second(s)",
    };

    log(`${logPrefix}: Collecting data for ${serverName}.`);

    // Set up perfmon service
    let perfmon_service = this.setupPerfmonService(serverName, jsonResults);
    log(`${logPrefix}: Found ${perfmonSessionArr.length} objects to collect on ${serverName}.`);

    // Build object collection array
    const objectCollectArr = await this.buildObjectCollectArray(
      perfmon_service, 
      serverName, 
      perfmonSessionArr
    );

    // Open session
    const sessionId = await this.openSession(perfmon_service, serverName, jsonResults);
    if (!sessionId) return jsonResults;

    // Add counters to session
    if (!await this.addCounters(perfmon_service, sessionId, objectCollectArr, serverName, jsonResults)) {
      return jsonResults;
    }

    // Collect baseline data
    if (!await this.collectBaseline(perfmon_service, sessionId, serverName, jsonResults)) {
      return jsonResults;
    }

    // Wait for data generation
    await this.delay(this.env.PM_OBJECT_SESSION_PERCENTAGE_SLEEP);
    log(`${logPrefix}: Waiting ${this.env.PM_OBJECT_SESSION_PERCENTAGE_SLEEP / 1000} seconds for ${serverName} to generate counter data.`);

    // Collect actual data
    if (!await this.collectData(perfmon_service, sessionId, serverName, jsonResults)) {
      return jsonResults;
    }

    // Clean up session
    await this.cleanupSession(perfmon_service, sessionId, objectCollectArr, serverName, jsonResults);

    return jsonResults;
  }

  setupPerfmonService(serverName, jsonResults) {
    const ssoArr = this.sessionSSO.getSSOArray();
    const ssoIndex = ssoArr.findIndex((element) => element.name === serverName);
    
    let perfmon_service;
    if (ssoIndex !== -1) {
      jsonResults.authMethod.sso++;
      perfmon_service = new perfMonService(
        serverName, 
        "", 
        "", 
        { cookie: ssoArr[ssoIndex].cookie }, 
        this.env.PM_RETRY_FLAG
      );
    } else {
      jsonResults.authMethod.basic++;
      perfmon_service = new perfMonService(
        serverName, 
        this.env.CUCM_USERNAME, 
        this.env.CUCM_PASSWORD, 
        {}, 
        this.env.PM_RETRY_FLAG
      );
    }
    
    return perfmon_service;
  }

  async buildObjectCollectArray(perfmon_service, serverName, perfmonSessionArr) {
    const objectCollectArr = [];
    
    const listCounterResults = await perfmon_service.listCounter(serverName, perfmonSessionArr);
    if (listCounterResults?.cookie) {
      this.sessionSSO.updateSSO(serverName, { cookie: listCounterResults.cookie });
    }

    for (let i = 0; i < perfmonSessionArr.length; i++) {
      const listInstanceResults = await perfmon_service.listInstance(serverName, perfmonSessionArr[i]);
      const findCounter = listCounterResults.results.find(
        (counter) => counter.Name === perfmonSessionArr[i]
      );
      
      const MultiInstance = /true/.test(findCounter?.MultiInstance);
      const locatePercentCounter = findCounter.ArrayOfCounter.item.filter(
        item => item.Name.includes("Percentage") || item.Name.includes("%")
      );

      for (let j = 0; j < locatePercentCounter.length; j++) {
        for (let k = 0; k < listInstanceResults.results.length; k++) {
          objectCollectArr.push({
            host: serverName,
            object: perfmonSessionArr[i],
            instance: MultiInstance ? listInstanceResults.results[k].Name : "",
            counter: locatePercentCounter[j].Name,
          });
        }
      }
    }

    return objectCollectArr;
  }

  async openSession(perfmon_service, serverName, jsonResults) {
    try {
      const sessionIdResults = await perfmon_service.openSession();
      if (sessionIdResults.results) {
        const sessionId = sessionIdResults.results;
        jsonResults.results.push({ 
          name: "openSession", 
          message: `Opening session for ${serverName} = ${sessionId}.` 
        });
        return sessionId;
      }
      throw new Error("No results returned");
    } catch (error) {
      this.handleSessionError(error, "openSession", serverName, jsonResults);
      return null;
    }
  }

  async addCounters(perfmon_service, sessionId, objectCollectArr, serverName, jsonResults) {
    try {
      const addCounterResults = await perfmon_service.addCounter(sessionId, objectCollectArr);
      if (addCounterResults.results) {
        jsonResults.results.push({ 
          name: "addCounter", 
          message: `Adding ${objectCollectArr.length} object(s) for ${serverName} with SessionId ${sessionId} = ${addCounterResults.results}.` 
        });
        return true;
      }
      throw new Error("No results returned");
    } catch (error) {
      this.handleSessionError(error, "addCounter", serverName, jsonResults);
      return false;
    }
  }

  async collectBaseline(perfmon_service, sessionId, serverName, jsonResults) {
    try {
      const baseLineResults = await perfmon_service.collectSessionData(sessionId);
      if (baseLineResults.results) {
        jsonResults.results.push({ 
          name: "collectSessionData", 
          message: `Collected ${baseLineResults.results.length} baseline points for ${serverName}.` 
        });
        return true;
      }
      throw new Error("No results returned");
    } catch (error) {
      this.handleSessionError(error, "collectSessionData", serverName, jsonResults);
      return false;
    }
  }

  async collectData(perfmon_service, sessionId, serverName, jsonResults) {
    try {
      const collectSessionResults = await perfmon_service.collectSessionData(sessionId);
      if (collectSessionResults.results) {
        // Update Prometheus metrics
        this.metricsRegistry.updateMetrics(collectSessionResults.results);
        
        jsonResults.results.push({ 
          name: "collectSessionData", 
          message: `Collected ${collectSessionResults.results.length} observation points for ${serverName} after sleeping.` 
        });
        return true;
      }
      throw new Error("No results returned");
    } catch (error) {
      this.handleSessionError(error, "collectSessionData", serverName, jsonResults);
      return false;
    }
  }

  async cleanupSession(perfmon_service, sessionId, objectCollectArr, serverName, jsonResults) {
    try {
      // Remove counters
      const removeCounterResults = await perfmon_service.removeCounter(sessionId, objectCollectArr);
      if (removeCounterResults.results) {
        jsonResults.results.push({ 
          name: "removeCounter", 
          message: `Removing objects for ${serverName} = ${removeCounterResults.results}.` 
        });
      }

      // Close session
      const closeSession = await perfmon_service.closeSession(sessionId);
      if (closeSession.results) {
        jsonResults.results.push({ 
          name: "closeSession", 
          message: `Closing session for ${serverName} = ${closeSession.results}.` 
        });
        log(`SessionCollector: Updated metrics for ${serverName}.`);
      }
    } catch (error) {
      this.handleSessionError(error, "cleanupSession", serverName, jsonResults);
    }
  }

  handleSessionError(error, functionName, serverName, jsonResults) {
    if (error.status >= 500) {
      this.rateControl = true;
      jsonResults.results.push({ 
        name: functionName, 
        message: `Error: ${error.message} for ${serverName}.` 
      });
    } else {
      log.error(`${functionName} Error:`, error);
      throw error;
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  logResults(results, logPrefix) {
    log(`${logPrefix} RESULTS:`);
    for (const result of results) {
      const table = result?.results;
      const authTable = result?.authMethod;
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

module.exports = SessionCollector;