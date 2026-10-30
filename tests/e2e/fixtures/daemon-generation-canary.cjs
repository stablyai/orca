const { spawn } = require('node:child_process')
const readline = require('node:readline')

const [label, nonce] = process.argv.slice(2)
if (!label || !nonce) {
  throw new Error('Usage: daemon-generation-canary <label> <nonce>')
}

const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
  stdio: 'ignore',
  windowsHide: true
})
console.log(`ORCA_GENERATION_CANARY_READY ${label} ${nonce} ${descendant.pid}`)

const input = readline.createInterface({ input: process.stdin })
input.on('line', (line) => {
  const prefix = `PING ${label} `
  if (line.startsWith(prefix)) {
    console.log(`ORCA_GENERATION_CANARY_ACK ${label} ${line.slice(prefix.length)}`)
  }
})

function shutdown() {
  input.close()
  if (descendant.pid) {
    try {
      process.kill(descendant.pid, 'SIGTERM')
    } catch {
      // The fixture-only process tree may already have been reaped.
    }
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
