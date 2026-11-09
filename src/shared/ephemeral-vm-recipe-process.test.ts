import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'

const tmpRoots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-vm-recipe-process-'))
  tmpRoots.push(root)
  return root
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runRecipeCommand', () => {
  it.skipIf(process.platform === 'win32')(
    'stops the recipe process group when the timeout elapses',
    async () => {
      vi.useFakeTimers()
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        unref: vi.fn()
      })
      try {
        const resultPromise = runRecipeCommand({
          command: 'create',
          repoPath: makeRepo(),
          mode: 'create',
          resultSchemaVersion: 1,
          context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
          timeoutMs: 60_000,
          spawnCommand: vi.fn(() => child) as never
        })

        await vi.advanceTimersByTimeAsync(59_999)
        expect(killSpy).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')

        // The shell ignores SIGTERM, so the group is force-killed after the grace period.
        await vi.advanceTimersByTimeAsync(5_000)
        expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL')
        const result = await resultPromise
        expect(result).toMatchObject({ timedOut: true, exitCode: null })
        expect(result).not.toHaveProperty('aborted')
      } finally {
        killSpy.mockRestore()
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'kills grandchildren of a recipe that outlives its timeout',
    async () => {
      const repoPath = makeRepo()
      const sleeperPath = join(repoPath, 'sleeper.js')
      const spawnerPath = join(repoPath, 'spawner.js')
      const pidPath = join(repoPath, 'grandchild.pid')
      writeFileSync(sleeperPath, 'setInterval(() => {}, 1000)\n')
      writeFileSync(
        spawnerPath,
        [
          "const { spawn } = require('node:child_process')",
          `const child = spawn(process.execPath, [${JSON.stringify(sleeperPath)}], { stdio: 'ignore' })`,
          `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
          "process.stderr.write('ready\\n')",
          'setInterval(() => {}, 1000)'
        ].join('\n')
      )
      // Fake only the deadline timers so the timeout fires after the grandchild exists, even under load.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const ready = Promise.withResolvers<void>()

      const resultPromise = runRecipeCommand({
        command: nodeCommand(spawnerPath),
        repoPath,
        mode: 'create',
        resultSchemaVersion: 1,
        context: { recipeId: 'cloud-sandbox', repoPath },
        timeoutMs: 1_000,
        onStderr: (chunk) => {
          if (chunk.includes('ready')) {
            ready.resolve()
          }
        }
      })
      await ready.promise
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await resultPromise
      vi.useRealTimers()

      expect(result).toMatchObject({ timedOut: true })
      expect(result).not.toHaveProperty('aborted')
      const grandchildPid = Number(readFileSync(pidPath, 'utf8'))
      await vi.waitFor(() => expect(isAlive(grandchildPid)).toBe(false), { timeout: 2_000 })
    },
    10_000
  )

  it('clears the force-kill timer when graceful termination closes synchronously', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    child.kill.mockImplementation(() => {
      child.emit('close', null, 'SIGTERM')
      return true
    })
    const controller = new AbortController()
    const resultPromise = runRecipeCommand({
      command: 'destroy',
      repoPath: makeRepo(),
      mode: 'destroy',
      resultSchemaVersion: 1,
      context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
      signal: controller.signal,
      spawnCommand: vi.fn(() => child) as never
    })

    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({ aborted: true, signal: 'SIGTERM' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { output: 'abcdef', maxCaptureBytes: 4, expected: 'cdef' },
    { output: 'A😀B', maxCaptureBytes: 5, expected: '😀B' },
    { output: '😀😀😀', maxCaptureBytes: 5, expected: '😀' }
  ])(
    'retains a complete UTF-8 tail within $maxCaptureBytes bytes',
    async ({ output, maxCaptureBytes, expected }) => {
      const repoPath = makeRepo()
      const scriptPath = join(repoPath, 'output.js')
      writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(output)})`)

      const result = await runRecipeCommand({
        command: nodeCommand(scriptPath),
        repoPath,
        mode: 'create',
        resultSchemaVersion: 1,
        context: {
          recipeId: 'cloud-sandbox',
          repoPath
        },
        maxCaptureBytes
      })

      expect(result.stdout).toBe(expected)
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(maxCaptureBytes)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'cancels shell child processes without waiting for long-running descendants',
    async () => {
      const repoPath = makeRepo()
      const scriptPath = join(repoPath, 'slow.js')
      writeFileSync(
        scriptPath,
        [
          "process.stderr.write('ready\\n')",
          'setTimeout(() => {',
          "  console.log('done')",
          '}, 5000)'
        ].join('\n')
      )
      const controller = new AbortController()

      const result = await Promise.race([
        runRecipeCommand({
          command: nodeCommand(scriptPath),
          repoPath,
          mode: 'create',
          resultSchemaVersion: 1,
          context: {
            recipeId: 'cloud-sandbox',
            repoPath
          },
          signal: controller.signal,
          onStderr: (chunk) => {
            if (chunk.includes('ready')) {
              controller.abort()
            }
          }
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('recipe cancellation timed out')), 1500)
        })
      ])

      expect(result).toMatchObject({ signal: 'SIGTERM', aborted: true })
    }
  )
})
