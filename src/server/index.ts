#!/usr/bin/env node
/**
 * Direct headless, Electron-free Orca runtime server bundle.
 * Thin wrapper that delegates to runNodeServer(); all logic lives in
 * src/main/server/* so it can be unit-tested without spawning a process.
 */
import { runNodeServer } from '../main/server/node-server-main'

runNodeServer().catch((error) => {
  console.error(
    '[orca-server] fatal:',
    error instanceof Error ? (error.stack ?? error.message) : error
  )
  process.exit(1)
})
