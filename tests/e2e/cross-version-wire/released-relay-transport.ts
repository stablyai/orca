/**
 * The client half of talking to a released relay: its own bridge transport and what a shipped
 * desktop did over it. Kept free of build tooling so Playwright specs can import it.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
 */
import { spawn } from 'node:child_process'
import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../../../src/main/ssh/ssh-channel-multiplexer'
import { RELAY_SENTINEL } from '../../../src/main/ssh/remote-exec/remote-frame-protocol'

const SENTINEL = Buffer.from(RELAY_SENTINEL, 'utf-8')
const OWNER_HELD_DISCONNECTED = -32045

/**
 * Runs a shell command the way an SSH exec channel would and hands back the relay stream after its
 * ready sentinel — the local stand-in for the bridge transport the client opens over SSH.
 */
export function openShellRelayTransport(command: string): Promise<MultiplexerTransport> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let pending: Buffer | null = Buffer.alloc(0)
    let ready = false
    const dataCallbacks: ((data: Buffer) => void)[] = []
    const closeCallbacks: (() => void)[] = []
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('close', () => {
      if (!ready) {
        reject(new Error(`relay bridge exited before ready: ${stderr.trim()}`))
        return
      }
      for (const callback of closeCallbacks) {
        callback()
      }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (ready) {
        for (const callback of dataCallbacks) {
          callback(chunk)
        }
        return
      }
      pending = Buffer.concat([pending ?? Buffer.alloc(0), chunk])
      const index = pending.indexOf(SENTINEL)
      if (index === -1) {
        return
      }
      ready = true
      const rest = pending.subarray(index + SENTINEL.length)
      pending = rest.length > 0 ? rest : null
      resolve({
        write: (data, onSettled) =>
          child.stdin.write(data, (error) =>
            onSettled?.(error ? { ok: false, error } : { ok: true })
          ),
        supportsWriteSettlement: true,
        onData: (callback) => {
          dataCallbacks.push(callback)
          if (pending) {
            const buffered = pending
            pending = null
            callback(buffered)
          }
        },
        onClose: (callback) => {
          closeCallbacks.push(callback)
        },
        close: () => {
          child.kill('SIGTERM')
        }
      })
    })
  })
}

/** A shipped 1.4.224 desktop: the owner role with output flow control, as that build asked for it. */
export async function connectAsReleasedApp(
  openTransport: () => Promise<MultiplexerTransport>,
  clientInstanceId: string
): Promise<SshChannelMultiplexer> {
  const app = new SshChannelMultiplexer(await openTransport())
  // As that build did: a holder that disconnected within its grace is waited out, never forced.
  for (let attempt = 0; ; attempt++) {
    try {
      await app.request('pty.openClient', {
        protocolVersion: 1,
        clientInstanceId,
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 256 * 1024 } }
      })
      return app
    } catch (error) {
      const code: unknown =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code !== OWNER_HELD_DISCONNECTED || attempt >= 40) {
        app.dispose()
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/**
 * What a shipped app leaves behind on quit: its relay keeps one shell that echoes each line it
 * reads (and its size on `size`), and the app's owner claim lapses. Returns the relay PTY id.
 */
export async function leaveShellInReleasedRelay(
  openTransport: () => Promise<MultiplexerTransport>,
  clientInstanceId: string,
  marker?: string
): Promise<string> {
  const oldApp = await connectAsReleasedApp(openTransport, clientInstanceId)
  const spawned: unknown = await oldApp.request('pty.spawn', { cols: 80, rows: 24 })
  const id: unknown =
    typeof spawned === 'object' && spawned !== null && 'id' in spawned ? spawned.id : undefined
  if (typeof id !== 'string') {
    throw new Error('released relay pty.spawn returned no id')
  }
  oldApp.notify('pty.data', {
    id,
    data:
      'stty -echo; while read -r l; do [ "$l" = quit ] && exit 0; ' +
      '[ "$l" = size ] && stty size; echo "GOT:$l"; done\n'
  })
  if (marker) {
    oldApp.notify('pty.data', { id, data: `${marker}\n` })
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  oldApp.dispose()
  return id
}
