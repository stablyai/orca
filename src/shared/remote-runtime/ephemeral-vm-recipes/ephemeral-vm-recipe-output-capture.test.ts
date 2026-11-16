import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fakeCommand(maxCaptureBytes?: number, signal?: AbortSignal) {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true),
    unref: vi.fn()
  })
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const result = runRecipeCommand({
    command: 'synthetic-recipe',
    repoPath: process.cwd(),
    context: { recipeId: 'fixture', repoPath: process.cwd() },
    mode: 'create',
    resultSchemaVersion: 1,
    maxCaptureBytes,
    signal,
    onStdout: (chunk) => stdoutChunks.push(chunk),
    onStderr: (chunk) => stderrChunks.push(chunk),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements every child member used by runRecipeCommand.
    spawnCommand: vi.fn(() => child) as never
  })
  return { child, result, stdoutChunks, stderrChunks }
}

describe('recipe output capture', () => {
  it('does not restore bytes discarded at an earlier chunk boundary', async () => {
    const fixture = fakeCommand(5)
    for (const chunk of ['😀', 'ab', 'c']) {
      fixture.child.stdout.emit('data', Buffer.from(chunk, 'utf8'))
    }
    fixture.child.emit('close', 0, null)
    await expect(fixture.result).resolves.toMatchObject({ stdout: 'abc' })
  })

  it('returns the captured tails when cancellation needs force-kill', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fixture = fakeCommand(6, controller.signal)
    fixture.child.stdout.emit('data', Buffer.from('abc😀Z'))
    fixture.child.stderr.emit('data', Buffer.from('error tail'))
    controller.abort()
    fixture.child.stdout.emit('data', Buffer.from('!'))
    await vi.advanceTimersByTimeAsync(5000)
    await expect(fixture.result).resolves.toEqual({
      stdout: '😀Z!',
      stderr: 'r tail',
      exitCode: null,
      signal: null,
      aborted: true
    })
    expect(fixture.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(fixture.child.unref).toHaveBeenCalledOnce()
  })
})
