'use strict';

const fs = require('fs');
const path = require('path');

function createLogger(scriptName) {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');

  const logDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

  const logFile = path.join(logDir, `${scriptName}_${yyyy}-${mm}-${dd}.log`);

  function append(type, message) {
    const timestamp = new Date().toISOString();
    const full = `[${timestamp}] [${type}] ${message}\n`;
    fs.appendFileSync(logFile, full);
    console.log(full.trim());
  }

  return {
    info: (msg) => append('INFO', msg),
    warn: (msg) => append('WARN', msg),
    error: (msg) => append('ERROR', msg),
  };
}

module.exports = createLogger;
