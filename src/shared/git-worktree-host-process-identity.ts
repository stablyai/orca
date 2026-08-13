import { randomUUID } from 'node:crypto'
import { createConnection, createServer } from 'node:net'

export type GitWorktreeHostProcessIdentity = Readonly<{
  pid: number
  port: number
  processToken: string
}>

export type GitWorktreeHostProcessState = 'alive' | 'dead' | 'unknown'

const PROCESS_PROBE_TIMEOUT_MS = 250
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/
let processIdentity: Promise<GitWorktreeHostProcessIdentity> | undefined

export function getGitWorktreeHostProcessIdentity(): Promise<GitWorktreeHostProcessIdentity> {
  processIdentity ??= new Promise((resolve, reject) => {
    const processToken = randomUUID()
    const server = createServer((socket) => {
      socket.on('error', () => undefined)
      socket.end(processToken)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      server.removeListener('error', reject)
      server.on('error', () => undefined)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Git worktree host process identity did not receive a TCP port.'))
        return
      }
      resolve({ pid: process.pid, port: address.port, processToken })
    })
  })
  return processIdentity
}

function isValidIdentity(identity: GitWorktreeHostProcessIdentity): boolean {
  return (
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    Number.isSafeInteger(identity.port) &&
    identity.port > 0 &&
    identity.port <= 65_535 &&
    TOKEN_PATTERN.test(identity.processToken)
  )
}

function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export async function probeGitWorktreeHostProcess(
  identity: GitWorktreeHostProcessIdentity,
  timeoutMs = PROCESS_PROBE_TIMEOUT_MS
): Promise<GitWorktreeHostProcessState> {
  if (!isValidIdentity(identity)) {
    return 'dead'
  }
  const ownIdentity = await getGitWorktreeHostProcessIdentity()
  if (identity.processToken === ownIdentity.processToken) {
    return identity.pid === ownIdentity.pid && identity.port === ownIdentity.port ? 'alive' : 'dead'
  }
  if (processIsDefinitelyDead(identity.pid)) {
    return 'dead'
  }
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: identity.port })
    let response = ''
    let settled = false
    const finish = (state: GitWorktreeHostProcessState): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(state)
    }
    const timer = setTimeout(() => finish('unknown'), Math.min(timeoutMs, PROCESS_PROBE_TIMEOUT_MS))
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      response += chunk
      if (response.length > 64) {
        finish('dead')
      }
    })
    socket.once('end', () => finish(response === identity.processToken ? 'alive' : 'dead'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'dead' : 'unknown')
    })
  })
}
