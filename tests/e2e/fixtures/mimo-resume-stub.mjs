#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const sessionId = args[args.indexOf('--session') + 1]
const mimoHome = process.env.MIMOCODE_HOME

if (!mimoHome) {
  throw new Error('MIMOCODE_HOME is missing')
}

const database = readFileSync(path.join(mimoHome, 'data', 'mimocode.db'))
if (!database.includes(sessionId)) {
  throw new Error(`Session data is unavailable through MIMOCODE_HOME: ${sessionId}`)
}

process.stdout.write(`MIMO_RESUME_STUB_STARTED ${JSON.stringify(args)}\r\n`)
setInterval(() => {}, 1_000)
