import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, test } from '@playwright/test'
import { DaemonClient } from '../../src/main/daemon/client'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath
} from '../../src/main/daemon/daemon-spawner'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

type FixtureDaemon = {
  child: ChildProcess
  protocolVersion: number
  socketPath: string
  tokenPath: string
  pidPath: string
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function launchFixture(
  entryPath: string,
  daemonDir: string,
  protocolVersion: number
): Promise<FixtureDaemon> {
  const socketPath = getDaemonSocketPath(daemonDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(daemonDir, protocolVersion)
  const pidPath = getDaemonPidPath(daemonDir, protocolVersion)
  const launchNonce = randomUUID()
  const child = fork(
    entryPath,
    [
      '--protocol',
      String(protocolVersion),
      '--socket',
      socketPath,
      '--token',
      tokenPath,
      ...(protocolVersion >= PROTOCOL_VERSION
        ? ['--pid-record', pidPath, '--launch-nonce', launchNonce]
        : [])
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_PATH: [path.join(process.cwd(), 'node_modules'), process.env.NODE_PATH]
          .filter(Boolean)
          .join(path.delimiter)
      }
    }
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_192)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout)
        child.off('message', onMessage)
        child.off('error', onError)
        child.off('exit', onExit)
      }
      const onMessage = (message: unknown): void => {
        if ((message as { type?: unknown }).type !== 'ready') {
          return
        }
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onExit = (code: number | null): void => {
        cleanup()
        reject(new Error(`Lifecycle fixture exited with ${code}: ${stderr.trim()}`))
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Lifecycle fixture startup timed out'))
      }, 10_000)
      child.on('message', onMessage)
      child.on('error', onError)
      child.on('exit', onExit)
    })
  } catch (error) {
    try {
      await stopChild(child, `fixture v${protocolVersion}`)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Fixture startup and cleanup both failed')
    }
    throw error
  }
  return { child, protocolVersion, socketPath, tokenPath, pidPath }
}

async function stopChild(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  child.kill('SIGTERM')
  try {
    await waitFor(
      `${label} graceful exit`,
      () => child.exitCode !== null || child.signalCode !== null,
      3_000
    )
    return
  } catch {
    child.kill('SIGKILL')
  }
  await waitFor(
    `${label} forced exit`,
    () => child.exitCode !== null || child.signalCode !== null,
    3_000
  )
}

async function stopFixture(fixture: FixtureDaemon): Promise<void> {
  await stopChild(fixture.child, `fixture v${fixture.protocolVersion}`)
}

test('v22 stays reattachable while v24 retires after its last empty client disconnects', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'orca-daemon-lifecycle-'))
  const daemonDir = path.join(rootDir, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  const entryPath = path.join(rootDir, 'daemon-lifecycle-entry.cjs')
  const fixtures: FixtureDaemon[] = []
  let testError: unknown

  try {
    await build({
      entryPoints: [path.join(process.cwd(), 'tests/e2e/fixtures/daemon-lifecycle-entry.ts')],
      outfile: entryPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: ['node-pty'],
      logLevel: 'silent'
    })

    const legacy = await launchFixture(entryPath, daemonDir, 22)
    fixtures.push(legacy)
    const legacyClient = new DaemonClient({
      socketPath: legacy.socketPath,
      tokenPath: legacy.tokenPath,
      protocolVersion: 22
    })
    await legacyClient.ensureConnected()
    await expect(
      legacyClient.request('createOrAttach', { sessionId: 'legacy-live', cols: 80, rows: 24 })
    ).resolves.toMatchObject({ isNew: true })
    legacyClient.disconnect()

    const current = await launchFixture(entryPath, daemonDir, PROTOCOL_VERSION)
    fixtures.push(current)
    const reattachClient = new DaemonClient({
      socketPath: legacy.socketPath,
      tokenPath: legacy.tokenPath,
      protocolVersion: 22
    })
    await reattachClient.ensureConnected()
    await expect(
      reattachClient.request('createOrAttach', {
        sessionId: 'legacy-live',
        cols: 80,
        rows: 24
      })
    ).resolves.toMatchObject({ isNew: false })
    reattachClient.disconnect()

    const currentAdapter = new DaemonPtyAdapter({
      socketPath: current.socketPath,
      tokenPath: current.tokenPath
    })
    const secondCurrentClient = new DaemonClient({
      socketPath: current.socketPath,
      tokenPath: current.tokenPath
    })
    await secondCurrentClient.ensureConnected()

    // Why: failed adoption may overlap another authenticated app client, so
    // only daemon-owned idle retirement can safely decide whether to exit.
    await currentAdapter.disconnectOnly()
    expect(current.child.exitCode).toBeNull()
    await expect(secondCurrentClient.request('listSessions', undefined)).resolves.toEqual({
      sessions: []
    })
    secondCurrentClient.disconnect()

    await waitFor('v24 process exit', () => current.child.exitCode !== null)
    expect(existsSync(current.tokenPath)).toBe(false)
    expect(existsSync(current.pidPath)).toBe(false)
    if (process.platform !== 'win32') {
      expect(existsSync(current.socketPath)).toBe(false)
    }
    expect(legacy.child.exitCode).toBeNull()
  } catch (error) {
    testError = error
  }

  const results = await Promise.allSettled(fixtures.map((fixture) => stopFixture(fixture)))
  const cleanupErrors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  try {
    rmSync(rootDir, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (testError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([testError, ...cleanupErrors], 'Lifecycle test and cleanup failed')
  }
  if (testError !== undefined) {
    throw testError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Lifecycle fixture cleanup failed')
  }
})
