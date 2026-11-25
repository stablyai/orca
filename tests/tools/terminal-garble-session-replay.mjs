#!/usr/bin/env node

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const loop = process.argv.includes('--loop')
const tickMs = Number(
  (process.argv.find((arg) => arg.startsWith('--tick=')) ?? '--tick=12').split('=')[1]
)
if (!Number.isFinite(tickMs) || tickMs <= 0) {
  throw new Error('--tick must be a positive number of milliseconds')
}
const url = (
  process.argv.find((arg) => arg.startsWith('--url=')) ??
  '--url=https://example.com/orca-terminal-garble-repro'
).slice('--url='.length)
const glyphChurnSeed = Number(
  (process.argv.find((arg) => arg.startsWith('--glyph-churn=')) ?? '--glyph-churn=-1').split('=')[1]
)
const frames = readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const bytes = Buffer.concat(
  frames.filter((frame) => frame.o).map((frame) => Buffer.from(frame.o, 'base64'))
)
const marker = Buffer.from('\x1b[?2026h')
const chunks = []
let position = 0

while (position < bytes.length) {
  let next = bytes.indexOf(marker, position + 1)
  if (next === -1) {
    next = bytes.length
  }
  chunks.push(bytes.subarray(position, next))
  position = next
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const overlay = Buffer.from(
  `\x1b7\x1b[1;1H\x1b]8;;${url}\x07\x1b[0;36;4m${url}\x1b[0m\x1b]8;;\x07\x1b[K\x1b8`
)
let glyphEpoch = 0

function glyphChurnOverlay() {
  if (glyphChurnSeed < 0) {
    return null
  }
  let output = '\x1b7'
  for (let row = 2; row < 14; row++) {
    output += `\x1b[${row};1H`
    for (let column = 0; column < 66; column++) {
      const key = glyphChurnSeed * 4099 + glyphEpoch * 997 + row * 67 + column
      const red = (key * 29) & 255
      const green = (key * 71) & 255
      const blue = (key * 131) & 255
      const glyph = String.fromCharCode(33 + (key % 94))
      output += `\x1b[38;2;${red};${green};${blue}m${glyph}`
    }
  }
  glyphEpoch++
  return Buffer.from(`${output}\x1b[0m\x1b8`)
}

do {
  for (const chunk of chunks) {
    process.stdout.write(chunk)
    const churn = glyphChurnOverlay()
    if (churn) {
      process.stdout.write(churn)
    }
    // Why: keep the real click trigger visible while replaying the captured
    // TUI frames; save/restore preserves the session's cursor state.
    process.stdout.write(overlay)
    await sleep(tickMs)
  }
  await sleep(300)
} while (loop)
