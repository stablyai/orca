#!/usr/bin/env node
'use strict'

// Deterministic stand-in for a real agent CLI, launched through the host
// agentLaunch boundary via a seeded custom agent's commandOverride. It prints a
// fixed readiness marker so the exact launch output is assertable, and echoes
// each received input line back with a distinct prefix so a test can prove that
// trusted keyboard input reached THIS process rather than local terminal echo.

const READY_MARKER = 'CUSTOM_AGENT_FIXTURE_READY'
const ECHO_PREFIX = 'CUSTOM_AGENT_ECHO:'
const ARGV_PREFIX = 'CUSTOM_AGENT_ARGV:'

function write(text) {
  process.stdout.write(text)
}

write(`${READY_MARKER}\r\n`)
// Echo the received extra argv (everything past `node <fixture>`) so a test can
// prove a host-resolved recipe's per-launch args reached THIS process's argv.
write(`${ARGV_PREFIX}${process.argv.slice(2).join(' ')}\r\n`)

process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) {
  // Raw mode disables the slave's line-discipline echo, so the only occurrence
  // of the typed text is the transformed echo line this process emits.
  process.stdin.setRawMode(true)
}
process.stdin.resume()

let line = ''
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char === '\x03') {
      // Ctrl-C: exit cleanly so the test can tear the session down.
      process.exit(0)
    }
    if (char === '\r' || char === '\n') {
      write(`${ECHO_PREFIX}${line}\r\n`)
      line = ''
      continue
    }
    line += char
  }
})
