'use strict'

const childProcess = require('node:child_process')
const { appendFileSync, mkdirSync } = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const path = require('node:path')
const workerThreads = require('node:worker_threads')

const outputDir = process.env.ORCA_PROCESS_ORACLE_SPAWN_DIR
const installed = Symbol.for('orca.processOracle.spawnProbe')

if (outputDir && !globalThis[installed]) {
  globalThis[installed] = true
  mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${process.pid}.ndjson`)
  const originalSpawn = childProcess.ChildProcess.prototype.spawn
  const syncBinding = process.binding('spawn_sync')
  const originalSyncSpawn = syncBinding.spawn
  const OriginalWorker = workerThreads.Worker

  workerThreads.Worker = class InstrumentedWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      const inheritedExecArgv = options.execArgv ?? process.execArgv
      const hasProbe = inheritedExecArgv.some(
        (value, index) => value === __filename || inheritedExecArgv[index - 1] === __filename
      )
      const execArgv = hasProbe
        ? inheritedExecArgv
        : [...inheritedExecArgv, '--require', __filename]
      super(filename, { ...options, execArgv })
    }
  }
  syncBuiltinESMExports()

  childProcess.ChildProcess.prototype.spawn = function instrumentedSpawn(options) {
    const timestamp = new Date().toISOString()
    const stack = new Error('child process spawned here').stack
    try {
      const result = originalSpawn.call(this, options)
      record({
        type: 'spawn',
        timestamp,
        parentPid: process.pid,
        returnedPid: Number.isInteger(this.pid) ? this.pid : null,
        executable: options?.file ?? null,
        argv: Array.isArray(options?.args) ? options.args : [],
        role: process.type ?? (process.env.ELECTRON_RUN_AS_NODE === '1' ? 'node' : 'node'),
        threadId: workerThreads.threadId,
        stack
      })
      return result
    } catch (error) {
      record({
        type: 'spawn-error',
        timestamp,
        parentPid: process.pid,
        returnedPid: null,
        executable: options?.file ?? null,
        argv: Array.isArray(options?.args) ? options.args : [],
        error: error instanceof Error ? error.message : String(error),
        threadId: workerThreads.threadId,
        stack
      })
      throw error
    }
  }

  syncBinding.spawn = function instrumentedSyncSpawn(options) {
    const timestamp = new Date().toISOString()
    const stack = new Error('synchronous child process spawned here').stack
    try {
      const result = originalSyncSpawn.call(this, options)
      record({
        type: 'spawn-sync',
        timestamp,
        parentPid: process.pid,
        returnedPid: Number.isInteger(result?.pid) ? result.pid : null,
        executable: options?.file ?? null,
        argv: Array.isArray(options?.args) ? options.args : [],
        role: process.type ?? (process.env.ELECTRON_RUN_AS_NODE === '1' ? 'node' : 'node'),
        threadId: workerThreads.threadId,
        stack
      })
      return result
    } catch (error) {
      record({
        type: 'spawn-sync-error',
        timestamp,
        parentPid: process.pid,
        returnedPid: null,
        executable: options?.file ?? null,
        argv: Array.isArray(options?.args) ? options.args : [],
        error: error instanceof Error ? error.message : String(error),
        threadId: workerThreads.threadId,
        stack
      })
      throw error
    }
  }

  function record(row) {
    appendFileSync(outputPath, `${JSON.stringify(row)}\n`)
  }

  record({
    type: 'preload',
    timestamp: new Date().toISOString(),
    parentPid: process.pid,
    ppid: process.ppid,
    argv: process.argv,
    threadId: workerThreads.threadId
  })
}
