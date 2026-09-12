import process from 'node:process'
import { writeFileSync } from 'node:fs'
import { startDaemon, type DaemonHandle } from '../../../src/main/daemon/daemon-main'
import { serializeDaemonPidFile } from '../../../src/main/daemon/daemon-spawner'
import type { SubprocessHandle } from '../../../src/main/daemon/session'

type FixtureArgs = {
  protocolVersion: number
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
}

function parseArgs(argv: string[]): FixtureArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key || !value) {
      throw new Error('Lifecycle fixture arguments must be key/value pairs')
    }
    values.set(key, value)
  }
  const protocolVersion = Number(values.get('--protocol'))
  const socketPath = values.get('--socket')
  const tokenPath = values.get('--token')
  const pidPath = values.get('--pid-record')
  const launchNonce = values.get('--launch-nonce')
  if (
    !Number.isInteger(protocolVersion) ||
    protocolVersion < 1 ||
    !socketPath ||
    !tokenPath ||
    Boolean(pidPath) !== Boolean(launchNonce)
  ) {
    throw new Error('Invalid lifecycle fixture arguments')
  }
  return {
    protocolVersion,
    socketPath,
    tokenPath,
    ...(pidPath && launchNonce ? { pidPath, launchNonce } : {})
  }
}

function createFixtureSubprocess(): SubprocessHandle {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  let exited = false
  const exit = (code: number): void => {
    if (exited) {
      return
    }
    exited = true
    onExit?.(code)
  }
  return {
    pid: process.pid,
    getForegroundProcess: () => null,
    write: (data) => onData?.(data),
    resize: () => {},
    kill: () => exit(0),
    forceKill: () => exit(137),
    signal: () => {},
    onData: (callback) => {
      onData = callback
    },
    onExit: (callback) => {
      onExit = callback
    },
    dispose: () => exit(0)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const startedAtMs = Date.now() - process.uptime() * 1000
  let daemon: DaemonHandle | null = await startDaemon({
    protocolVersion: args.protocolVersion,
    socketPath: args.socketPath,
    tokenPath: args.tokenPath,
    ...(args.pidPath ? { pidPath: args.pidPath } : {}),
    ...(args.launchNonce ? { launchNonce: args.launchNonce } : {}),
    startedAtMs,
    spawnSubprocess: () => createFixtureSubprocess(),
    onIdleShutdown: () => process.exit(0)
  })
  if (args.pidPath && args.launchNonce) {
    writeFileSync(
      args.pidPath,
      serializeDaemonPidFile({
        pid: process.pid,
        startedAtMs,
        launchNonce: args.launchNonce
      }),
      { mode: 0o600, flag: 'wx' }
    )
  }

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    try {
      await daemon?.shutdown()
      daemon = null
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  process.send?.({ type: 'ready', pid: process.pid, startedAtMs })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
