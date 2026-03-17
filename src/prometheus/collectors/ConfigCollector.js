const log = require("fancy-log");
const perfMonService = require("cisco-perfmon");

class ConfigCollector {
  constructor(env, sessionSSO, metricsRegistry) {
    this.env = env;
    this.sessionSSO = sessionSSO;
    this.metricsRegistry = metricsRegistry;
    this.rateControl = false;
  }

  async collect(data, logPrefix) {
    log(`${logPrefix}: Starting collection from ${this.env.CUCM_HOSTNAME} using config.json file`);
    const parsedData = JSON.parse(data);

    const jsonResults = {
      server: this.env.CUCM_HOSTNAME,
      authMethod: { basic: 0, sso: 0 },
      results: [],
      cooldownTimer: this.env.PM_COOLDOWN_TIMER / 1000 + " second(s)",
      intervalTimer: this.env.PM_INTERVAL / 1000 + " second(s)",
    };

    // Set up perfmon service
    let perfmon_service = this.setupPerfmonService(jsonResults);
    log(`${logPrefix}: Found ${parsedData.length} objects to collect on ${this.env.CUCM_HOSTNAME}.`);

    // Open session
    const sessionId = await this.openSession(perfmon_service, jsonResults);
    if (!sessionId) return jsonResults;

    // Add counters to session
    if (!await this.addCounters(perfmon_service, sessionId, parsedData, jsonResults)) {
      return jsonResults;
    }

    // Collect data
    if (!await this.collectData(perfmon_service, sessionId, jsonResults)) {
      return jsonResults;
    }

    // Clean up session
    await this.cleanupSession(perfmon_service, sessionId, parsedData, jsonResults);

    this.logResults(jsonResults, logPrefix);

    if (this.rateControl) {
      this.rateControl = false;
      throw new Error("RateControl detected.");
    }

    return jsonResults;
  }

  setupPerfmonService(jsonResults) {
    const ssoArr = this.sessionSSO.getSSOArray();
    const ssoIndex = ssoArr.findIndex((element) => element.name === this.env.CUCM_HOSTNAME);
    
    let perfmon_service;
    if (ssoIndex !== -1) {
      jsonResults.authMethod.sso++;
      perfmon_service = new perfMonService(
        this.env.CUCM_HOSTNAME, 
        "", 
        "", 
        { cookie: ssoArr[ssoIndex].cookie }, 
        this.env.PM_RETRY_FLAG
      );
    } else {
      jsonResults.authMethod.basic++;
      perfmon_service = new perfMonService(
        this.env.CUCM_HOSTNAME, 
        this.env.CUCM_USERNAME, 
        this.env.CUCM_PASSWORD, 
        {}, 
        this.env.PM_RETRY_FLAG
      );
    }
    
    return perfmon_service;
  }

  async openSession(perfmon_service, jsonResults) {
    try {
      const sessionIdResults = await perfmon_service.openSession();
      if (sessionIdResults.cookie) {
        this.sessionSSO.updateSSO(this.env.CUCM_HOSTNAME, { cookie: sessionIdResults.cookie });
      }
      
      if (sessionIdResults?.results) {
        const sessionId = sessionIdResults.results;
        jsonResults.results.push({ 
          name: "openSession", 
          message: `Opening session for ${this.env.CUCM_HOSTNAME} = ${sessionId}.` 
        });
        return sessionId;
      }
      throw new Error("No results returned");
    } catch (error) {
      this.handleSessionError(error, "openSession", jsonResults);
      return null;
    }
  }

  async addCounters(perfmon_service, sessionId, parsedData, jsonResults) {
    try {
      const addCounterResults = await perfmon_service.addCounter(sessionId, parsedData);
      if (addCounterResults.results) {
        jsonResults.results.push({ 
          name: "addCounter", 
          message: `Adding ${parsedData.length} object(s) for ${this.env.CUCM_HOSTNAME} with SessionId ${sessionId} = ${addCounterResults.results}.` 
        });
        return true;
      }
      throw new Error("No results returned");
    } catch (error) {
      this.handleSessionError(error, "addCounter", jsonResults);
      return false;
    }
  }

  async collectData(perfmon_service, sessionId, jsonResults) {
    try {
      const collectSessionResults = await perfmon_service.collectSessionData(sessionId);
      if (collectSessionResults.results) {
        // Update Prometheus metrics
        this.metricsRegistry.updateMetrics(collectSessionResults.results);
        
        jsonResults.results.push({ 
          name: "collectSessionData", 
          message: `Collected ${collectSessionResults.results.length} observation points from ${this.env.CUCM_HOSTNAME}.` 
        });
        return true;
      }
      throw new Error("No results returned");
    } catch (error) {
      this.handleSessionError(error, "collectSessionData", jsonResults);
      return false;
    }
  }

  async cleanupSession(perfmon_service, sessionId, parsedData, jsonResults) {
    try {
      // Remove counters
      const removeCounterResults = await perfmon_service.removeCounter(sessionId, parsedData);
      if (removeCounterResults.results) {
        jsonResults.results.push({ 
          name: "removeCounter", 
          message: `Removing object(s) for ${this.env.CUCM_HOSTNAME} = ${removeCounterResults.results}.` 
        });
      }

      // Close session
      const closeSession = await perfmon_service.closeSession(sessionId);
      if (closeSession.results) {
        jsonResults.results.push({ 
          name: "closeSession", 
          message: `Closing session for ${this.env.CUCM_HOSTNAME} = ${closeSession.results}.` 
        });
        log(`ConfigCollector: Updated metrics from ${this.env.CUCM_HOSTNAME}.`);
      }
    } catch (error) {
      this.handleSessionError(error, "cleanupSession", jsonResults);
    }
  }

  handleSessionError(error, functionName, jsonResults) {
    if (error.status >= 500) {
      this.rateControl = true;
      jsonResults.results.push({ 
        name: functionName, 
        message: `Error: ${error.message} for ${jsonResults.server}` 
      });
    } else {
      log.error(`${functionName} Error:`, error);
      throw error;
    }
  }

  logResults(jsonResults, logPrefix) {
    log(`${logPrefix} Basic Settings:`);
    const table = jsonResults.results;
    const authTable = jsonResults.authMethod;
    delete jsonResults.authMethod;
    delete jsonResults.results;
    console.table(jsonResults);
    log(`${logPrefix} Auth Counts:`);
    console.table(authTable);
    log(`${logPrefix} Object Results:`);
    console.table(table);
  }
}

module.exports = ConfigCollector;