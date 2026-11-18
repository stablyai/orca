import { EventEmitter, once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeElectronAppForE2E } from './electron-process-shutdown'

function exitedAppFixture() {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    stdio: [new PassThrough(), new PassThrough(), new PassThrough()]
  })
  const pipesClosed = Promise.all(
    proc.stdio.map((stream) => new Promise<void>((resolve) => stream.once('close', resolve)))
  )
  const close = vi.fn(() => pipesClosed)
  const app = {
    process: () => proc as unknown as ChildProcess,
    close
  } as unknown as ElectronApplication
  return { proc, app, close }
}

const ownedChildren = new Set<ChildProcess>()
const ownedProfiles = new Set<string>()

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return true
    }
    throw error
  }
}

async function ownedDaemon(mode: 'exit' | 'ignore' | 'descendant') {
  const proc = spawnProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: [
      '-e',
      `
        const { spawn } = require('node:child_process')
        const mode = process.argv[1]
        setInterval(() => {}, 1000)
        if (mode === 'ignore') process.on('SIGTERM', () => {})
        if (mode === 'descendant') {
          const child = spawn(process.execPath, ['-e', \`
            process.on('SIGTERM', () => {})
            setInterval(() => {}, 1000)
            process.send(process.pid)
          \`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
          child.once('message', pid => process.send({ node: process.versions.node, pids: [process.pid, pid] }))
        } else {
          process.send({ node: process.versions.node, pids: [process.pid] })
        }
      `,
      mode
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    detached: true,
    timeoutMs: null
  })
  ownedChildren.add(proc)
  const exited = once(proc, 'exit')
  const readiness: unknown = (await once(proc, 'message'))[0]
  if (
    !readiness ||
    typeof readiness !== 'object' ||
    !('node' in readiness) ||
    typeof readiness.node !== 'string' ||
    !('pids' in readiness) ||
    !Array.isArray(readiness.pids)
  ) {
    throw new Error('Missing real Node daemon readiness')
  }
  const pids = readiness.pids.map((pid: unknown) => {
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error('Invalid owned daemon PID')
    }
    return pid
  })
  if (!proc.pid || pids[0] !== proc.pid) {
    throw new Error('Daemon readiness does not belong to the spawned child')
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'orca-daemon-exit-'))
  ownedProfiles.add(profile)
  mkdirSync(path.join(profile, 'daemon'))
  writeFileSync(path.join(profile, 'daemon', 'owned.pid'), JSON.stringify({ pid: proc.pid }))
  return { proc, pids, profile, exited }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const proc of ownedChildren) {
    const pid = proc.pid
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw error
        }
      }
      if (proc.exitCode === null && proc.signalCode === null) {
        await once(proc, 'exit')
      }
      await expect.poll(() => pidIsGone(-pid), { timeout: 5_000 }).toBe(true)
    }
  }
  ownedChildren.clear()
  for (const profile of ownedProfiles) {
    rmSync(profile, { recursive: true, force: true })
  }
  ownedProfiles.clear()
})

describe.skipIf(process.platform === 'win32')('owned POSIX daemon cleanup', () => {
  it('preserves a running daemon when final cleanup is not requested', async () => {
    const daemon = await ownedDaemon('exit')
    const { proc, app } = exitedAppFixture()
    proc.exitCode = 0
    await closeElectronAppForE2E(app)
    expect(daemon.pids.every((pid) => !pidIsGone(pid))).toBe(true)
  })
})
