import process from 'node:process'
import { startDaemon, type DaemonHandle } from '../../../src/main/daemon/daemon-main'
import { createPtySubprocess } from '../../../src/main/daemon/pty-subprocess'
import { createDaemonFileLog } from '../../../src/main/daemon/daemon-file-log'

type FixtureArgs = {
  protocolVersion: number
  socketPath: string
  tokenPath: string
  logPath: string
  refuseDispose: boolean
}

function parseFixtureArgs(argv: string[]): FixtureArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key || !value) {
      throw new Error('Daemon generation fixture arguments must be key/value pairs')
    }
    values.set(key, value)
  }

  const protocolVersion = Number(values.get('--protocol'))
  const socketPath = values.get('--socket')
  const tokenPath = values.get('--token')
  const logPath = values.get('--log')
  const refuseDispose = values.get('--refuse-dispose') === 'true'
  if (
    !Number.isInteger(protocolVersion) ||
    protocolVersion < 1 ||
    !socketPath ||
    !tokenPath ||
    !logPath
  ) {
    throw new Error(
      'Usage: daemon-generation-entry --protocol <n> --socket <path> --token <path> --log <path>'
    )
  }
  return { protocolVersion, socketPath, tokenPath, logPath, refuseDispose }
}

async function main(): Promise<void> {
  const { protocolVersion, socketPath, tokenPath, logPath, refuseDispose } = parseFixtureArgs(
    process.argv.slice(2)
  )
  let daemon: DaemonHandle | null = await startDaemon({
    protocolVersion,
    socketPath,
    tokenPath,
    log: createDaemonFileLog(logPath),
    spawnSubprocess: (options) => {
      const subprocess = createPtySubprocess(options)
      if (refuseDispose) {
        // Why: models an access-denied/unreapable Windows PTY while keeping the
        // real child and ConPTY handle inside this disposable fixture tree.
        subprocess.kill = () => {}
        subprocess.forceKill = () => {}
      }
      return subprocess
    }
  })
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
  process.send?.({
    type: 'ready',
    protocolVersion,
    startedAtMs: Date.now() - process.uptime() * 1000
  })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
