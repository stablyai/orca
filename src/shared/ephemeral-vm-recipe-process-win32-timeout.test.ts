import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: spawnMock
}))
vi.mock('@orca/process-host/process-tree-kill-gate', () => ({
  admitProcessTreeKill: () => true
}))

const { runRecipeCommand } = await import('./ephemeral-vm-recipe-process')

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  vi.useRealTimers()
  spawnMock.mockReset()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('runRecipeCommand timeout on Windows', () => {
  it('walks the whole process tree with taskkill when the timeout elapses', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers()
    spawnMock.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }))
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })

    const resultPromise = runRecipeCommand({
      command: 'create',
      repoPath: process.cwd(),
      mode: 'create',
      resultSchemaVersion: 1,
      context: { recipeId: 'cloud-sandbox', repoPath: process.cwd() },
      timeoutMs: 1_000,
      spawnCommand: vi.fn(() => child) as never
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.emit('close', 1, null)
    await expect(resultPromise).resolves.toMatchObject({ timedOut: true, exitCode: 1 })
  })
})
