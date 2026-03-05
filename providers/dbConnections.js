'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const firebird = require('node-firebird');
const { Pool } = require('pg');

// ---------------------------
// MYSQL (prontoweb)
// ---------------------------
let mysqlPool;

function getMySqlConnection() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      port: process.env.MYSQL_PORT || 3306,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return mysqlPool;
}

// ---------------------------
// POSTGRESQL (si se usa)
// ---------------------------
let pgPool;

function getPostgresPool() {
  if (!pgPool) {
    pgPool = new Pool({
      host: process.env.PG_HOST,
      port: process.env.PG_PORT,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      database: process.env.PG_DATABASE,
      max: 20,
    });
  }
  return pgPool;
}

// ---------------------------
// FIREBIRD (IDEAL)
// ---------------------------
const firebirdOptions = {
  host: process.env.FB_HOST,
  port: Number(process.env.FB_PORT) || 3050,
  database: process.env.FB_DATABASE,
  user: process.env.FB_USER,
  password: process.env.FB_PASSWORD,
  role: null,
  pageSize: 4096,
};

function getFirebirdConnection() {
  return new Promise((resolve, reject) => {
    firebird.attach(firebirdOptions, function (err, db) {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

function firebirdQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, function (err, result) {
      if (err) return reject(err);
      resolve(result || []);
    });
  });
}

// ---------------------------
module.exports = {
  getMySqlConnection,
  getPostgresPool,
  getFirebirdConnection,
  firebirdQuery,
};
