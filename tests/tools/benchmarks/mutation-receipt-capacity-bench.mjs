#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const ROW_LIMIT = 10_000
const PRUNE_BATCH_SIZE = 64

function parseArgs(argv) {
  const options = { iterations: 32, payloadBytes: 9_500 }
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--iterations') {
      options.iterations = Number(value)
    } else if (argv[index] === '--payload-bytes') {
      options.payloadBytes = Number(value)
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`)
    }
    index += 1
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
    throw new Error('--iterations must be a positive integer')
  }
  if (!Number.isSafeInteger(options.payloadBytes) || options.payloadBytes < 0) {
    throw new Error('--payload-bytes must be a non-negative integer')
  }
  return options
}

function createFixture(path, payloadBytes, optimized) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE mutation_receipts (
      caller_fingerprint TEXT NOT NULL,
      request_id TEXT NOT NULL,
      method TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      receipt BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (caller_fingerprint, request_id)
    );
    WITH RECURSIVE receipt_numbers(value) AS (
      VALUES (1)
      UNION ALL
      SELECT value + 1 FROM receipt_numbers WHERE value < ${ROW_LIMIT}
    )
    INSERT INTO mutation_receipts (
      caller_fingerprint, request_id, method, payload_hash, state, receipt
    )
    SELECT 'caller', printf('request_%05d', value), 'orchestration.send',
           printf('hash_%05d', value), 'completed', zeroblob(${payloadBytes})
    FROM receipt_numbers;
  `)
  if (optimized) {
    db.exec(`
      CREATE INDEX idx_mutation_receipts_completed_updated
        ON mutation_receipts(updated_at) WHERE state = 'completed';
      CREATE TABLE mutation_receipt_ledger (
        singleton INTEGER PRIMARY KEY,
        receipt_count INTEGER NOT NULL
      );
      INSERT INTO mutation_receipt_ledger VALUES (1, ${ROW_LIMIT});
      CREATE TRIGGER mutation_receipts_count_insert AFTER INSERT ON mutation_receipts
      BEGIN
        UPDATE mutation_receipt_ledger SET receipt_count = receipt_count + 1;
      END;
      CREATE TRIGGER mutation_receipts_count_delete AFTER DELETE ON mutation_receipts
      BEGIN
        UPDATE mutation_receipt_ledger SET receipt_count = receipt_count - 1;
      END;
    `)
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return db
}

function runLegacyMutation(db, iteration) {
  db.exec('BEGIN IMMEDIATE')
  db.prepare(
    `DELETE FROM mutation_receipts
     WHERE state = 'completed' AND updated_at < datetime('now', '-30 days')`
  ).run()
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get()
  const completedToRemove = count - ROW_LIMIT + 1
  if (completedToRemove > 0) {
    db.prepare(
      `DELETE FROM mutation_receipts WHERE rowid IN (
         SELECT rowid FROM mutation_receipts WHERE state = 'completed'
         ORDER BY updated_at, rowid LIMIT ?
       )`
    ).run(completedToRemove)
  }
  db.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get()
  insertReceipt(db, iteration)
  db.exec('COMMIT')
}

function runOptimizedMutation(db, iteration) {
  db.exec('BEGIN IMMEDIATE')
  db.prepare(
    `DELETE FROM mutation_receipts
     WHERE state = 'completed' AND updated_at < datetime('now', '-30 days')`
  ).run()
  const { receipt_count: count } = db
    .prepare('SELECT receipt_count FROM mutation_receipt_ledger WHERE singleton = 1')
    .get()
  if (count >= ROW_LIMIT) {
    db.prepare(
      `DELETE FROM mutation_receipts WHERE rowid IN (
         SELECT rowid FROM mutation_receipts WHERE state = 'completed'
         ORDER BY updated_at, rowid LIMIT ?
       )`
    ).run(count - ROW_LIMIT + PRUNE_BATCH_SIZE)
  }
  db.prepare('SELECT receipt_count FROM mutation_receipt_ledger WHERE singleton = 1').get()
  insertReceipt(db, iteration)
  db.exec('COMMIT')
}

function insertReceipt(db, iteration) {
  db.prepare(
    `INSERT INTO mutation_receipts (
       caller_fingerprint, request_id, method, payload_hash, state
     ) VALUES ('benchmark', ?, 'orchestration.send', ?, 'pending')`
  ).run(`new_${iteration}`, `new_hash_${iteration}`)
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function measure(db, iterations, mutation) {
  const samplesMs = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    mutation(db, index)
    samplesMs.push(performance.now() - startedAt)
  }
  const sorted = samplesMs.toSorted((left, right) => left - right)
  return {
    firstMs: samplesMs[0],
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
    totalMs: samplesMs.reduce((sum, value) => sum + value, 0)
  }
}

const options = parseArgs(process.argv)
const fixtureDir = mkdtempSync(join(tmpdir(), 'orca-mutation-receipt-bench-'))
try {
  const legacyPath = join(fixtureDir, 'legacy.db')
  const optimizedPath = join(fixtureDir, 'optimized.db')
  const legacyDb = createFixture(legacyPath, options.payloadBytes, false)
  const optimizedDb = createFixture(optimizedPath, options.payloadBytes, true)
  const databaseBytes = statSync(legacyPath).size
  const legacy = measure(legacyDb, options.iterations, runLegacyMutation)
  const optimized = measure(optimizedDb, options.iterations, runOptimizedMutation)
  legacyDb.close()
  optimizedDb.close()

  process.stdout.write(
    `${JSON.stringify(
      {
        rows: ROW_LIMIT,
        payloadBytes: options.payloadBytes,
        databaseBytes,
        iterations: options.iterations,
        legacy,
        optimized,
        medianSpeedup: legacy.medianMs / optimized.medianMs,
        totalSpeedup: legacy.totalMs / optimized.totalMs
      },
      null,
      2
    )}\n`
  )
} finally {
  rmSync(fixtureDir, { recursive: true, force: true })
}
