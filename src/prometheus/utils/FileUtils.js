const fs = require("fs").promises;
const log = require("fancy-log");

class FileUtils {
  static async checkAndRead(filePath) {
    try {
      // Check if the file exists
      await fs.access(filePath);

      // Read the file contents
      const data = await fs.readFile(filePath, "utf-8");
      return data;
    } catch (err) {
      if (err.code === "ENOENT") {
        log.error("PERFMON SESSION CONFIG: File does not exist:", filePath, "Skipping collection via config file.");
      } else {
        log.error("PERFMON SESSION CONFIG Error accessing file:", err);
      }
      return null;
    }
  }

  static commaSeparatedList(value) {
    return value.split(",");
  }

  static delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = FileUtils;