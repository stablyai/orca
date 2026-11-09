import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
