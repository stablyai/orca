#!/usr/bin/env node
// Run each case in a fresh process: ORCA_BACKGROUND_LAUNCH=1 node --expose-gc <file> [rows] [cols] [short-log|styled-wide] [desktop|headless].
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import headless from '@xterm/headless'
import desktop from '@xterm/xterm'
import serialize from '@xterm/addon-serialize'

const depth = Number(process.argv[2] ?? 50000)
const cols = Number(process.argv[3] ?? 200)
const fixture = process.argv[4] ?? 'short-log'
const implementation = process.argv[5] ?? 'desktop'
assert(Number.isSafeInteger(depth) && depth > 0 && depth <= 200000)
assert(Number.isSafeInteger(cols) && cols >= 40 && cols <= 1000)
assert(['short-log', 'styled-wide'].includes(fixture))
assert(['desktop', 'headless'].includes(implementation))
assert(global.gc, 'Use --expose-gc for retained-memory measurements')

async function collectRetiredBuffers() {
  // V8 may release retired ArrayBuffers after the collection callback returns.
  for (let i = 0; i < 2; i++) {
    await new Promise(setImmediate)
    global.gc()
  }
}

async function measure() {
  await collectRetiredBuffers()
  const before = process.memoryUsage()
  const { Terminal } = implementation === 'desktop' ? desktop : headless
  const term = new Terminal({ cols, rows: 24, scrollback: depth, allowProposedApi: true })
  const addon = new serialize.SerializeAddon()
  term.loadAddon(addon)
  try {
    const start = performance.now()
    for (let offset = 0; offset < depth + 24; offset += 256) {
      let chunk = ''
      for (let i = offset; i < Math.min(depth + 24, offset + 256); i++) {
        chunk +=
          fixture === 'short-log'
            ? `row ${i}: completed task\r\n`
            : `\x1b[38;2;120;160;200m${i}: 漢字 e\u0301 🙂 \x1b[0m${'x'.repeat(cols - 35)}\r\n`
      }
      await new Promise((resolve) => term.write(chunk, resolve))
    }
    const writeMs = performance.now() - start
    await collectRetiredBuffers()
    const after = process.memoryUsage()
    const lines = term._core._bufferService.buffers.normal.lines
    const retainedRows = lines.length
    let storedCellBytes = 0
    let packedRows = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines.get(i)
      // Avoid the expanding _data accessor when inspecting compact rows.
      const storage = line._packedData ?? line._rawData ?? line._data
      storedCellBytes += storage.byteLength
      if (line._packedData) {
        packedRows++
      }
    }
    const serializeStart = performance.now()
    const ansi = addon.serialize()
    const serializeMs = performance.now() - serializeStart
    const resizeStart = performance.now()
    term.resize(80, 24)
    term.resize(cols, 24)
    const resizeMs = performance.now() - resizeStart
    const resizedAnsi = addon.serialize()
    return {
      node: process.version,
      platform: process.platform,
      implementation,
      cols,
      depth,
      fixture,
      retainedRows,
      packedRows,
      heapDelta: after.heapUsed - before.heapUsed,
      arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
      logicalCellBytes: retainedRows * cols * 12,
      storedCellBytes,
      ansiBytes: Buffer.byteLength(ansi),
      writeMs,
      serializeMs,
      resizeMs,
      sha256: createHash('sha256').update(ansi).digest('hex'),
      resizedSha256: createHash('sha256').update(resizedAnsi).digest('hex')
    }
  } finally {
    term.dispose()
  }
}

console.log(JSON.stringify(await measure()))
