'use strict';

const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');

const keyPath = path.join(__dirname, 'bigquery-key.json');

const bigquery = new BigQuery({
  keyFilename: keyPath,
  projectId: process.env.BQ_PROJECT_ID,
});

module.exports = bigquery;
