// migrate.js - Create the database and tables. Safe to run repeatedly: `npm run migrate`
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbName = process.env.DB_NAME || 'suba_db';

const baseConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
};

async function migrate() {
  const server = await mysql.createConnection(baseConfig);
  await server.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await server.end();
  console.log(`✅ Database '${dbName}' ready.`);

  const conn = await mysql.createConnection({ ...baseConfig, database: dbName });
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migration.sql'), 'utf8');
    await conn.query(sql);

    // Older databases were created without this column.
    const [cols] = await conn.query(
      `SELECT 1 FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'default_monthly_budget'`,
      [dbName]
    );
    if (cols.length === 0) {
      await conn.query(
        'ALTER TABLE users ADD COLUMN default_monthly_budget decimal(10,2) DEFAULT 0.00 AFTER default_currency'
      );
      console.log('✅ Added users.default_monthly_budget column.');
    }

    console.log('✅ Migration completed successfully!');
  } finally {
    await conn.end();
  }
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
