'use strict';

require('dotenv').config({ path: 'c:/scripts/bigcommerce-updates/.env' });
const { getFirebirdConnection, firebirdQuery } = require('../providers/dbConnections');

async function main() {
  const db = await getFirebirdConnection();
  try {
    const queries = [
      ['total_pod', 'SELECT COUNT(*) AS C FROM PURCHASEORDERDETAIL pod', []],
      ['pod_with_calc_not_null', 'SELECT COUNT(*) AS C FROM PURCHASEORDERDETAIL pod WHERE pod.CALCSALESORDERID IS NOT NULL', []],
      ['po_status_B', 'SELECT COUNT(*) AS C FROM PURCHASEORDERDETAIL pod JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID WHERE po.PURCHASEORDERSTATUS = ?', ['B']],
      ['po_status_B_salesrep_internet', "SELECT COUNT(*) AS C FROM PURCHASEORDERDETAIL pod JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID JOIN SALESORDER so ON so.SALESORDERID = pod.CALCSALESORDERID WHERE po.PURCHASEORDERSTATUS = ? AND UPPER(TRIM(so.SALESREP)) = ?", ['B', 'INTERNET']],
      ['all_joins_filters_no_age', "SELECT COUNT(*) AS C FROM PURCHASEORDERDETAIL pod JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID JOIN SALESORDER so ON so.SALESORDERID = pod.CALCSALESORDERID WHERE pod.CALCSALESORDERID IS NOT NULL AND po.PURCHASEORDERSTATUS = ? AND UPPER(TRIM(so.SALESREP)) = ?", ['B', 'INTERNET']],
      ['grouped_parts_no_age', "SELECT COUNT(*) AS C FROM (SELECT pod.MFRID, pod.PARTNUMBER FROM PURCHASEORDERDETAIL pod JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID JOIN SALESORDER so ON so.SALESORDERID = pod.CALCSALESORDERID WHERE pod.CALCSALESORDERID IS NOT NULL AND po.PURCHASEORDERSTATUS = ? AND UPPER(TRIM(so.SALESREP)) = ? GROUP BY pod.MFRID, pod.PARTNUMBER) x", ['B', 'INTERNET']],
    ];

    for (const [name, sql, params] of queries) {
      const rows = await firebirdQuery(db, sql, params);
      const c = rows?.[0]?.C ?? rows?.[0]?.c;
      console.log(`${name}: ${c}`);
    }

    const sampleSql = `
      SELECT FIRST 20
        pod.MFRID,
        pod.PARTNUMBER,
        MIN(po.ORDERDATE) AS FIRST_ORDERDATE
      FROM PURCHASEORDERDETAIL pod
      JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID
      JOIN SALESORDER so ON so.SALESORDERID = pod.CALCSALESORDERID
      WHERE pod.CALCSALESORDERID IS NOT NULL
        AND po.PURCHASEORDERSTATUS = ?
        AND UPPER(TRIM(so.SALESREP)) = ?
      GROUP BY pod.MFRID, pod.PARTNUMBER
      ORDER BY FIRST_ORDERDATE ASC
    `;

    const sample = await firebirdQuery(db, sampleSql, ['B', 'INTERNET']);
    console.log(`sample_rows: ${sample.length}`);
    console.log(sample.slice(0, 10));

    const candidatesSql = `
      SELECT FIRST 20
        pod.PURCHASEORDERID,
        pod.CALCSALESORDERID,
        pod.MFRID,
        pod.PARTNUMBER,
        po.ORDERDATE,
        po.SALESREP,
        po.PURCHASEORDERSTATUS
      FROM PURCHASEORDERDETAIL pod
      JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID
      JOIN SALESORDER so ON so.SALESORDERID = pod.CALCSALESORDERID
      WHERE po.PURCHASEORDERSTATUS = ?
        AND UPPER(TRIM(so.SALESREP)) = ?
      ORDER BY po.ORDERDATE ASC
    `;

    const candidates = await firebirdQuery(db, candidatesSql, ['B', 'INTERNET']);
    console.log(`candidates_rows: ${candidates.length}`);
    console.log(candidates);
  } finally {
    db.detach();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
