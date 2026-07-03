import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'

const tmpRoots: string[] = []

afterEach(() => {
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

describe('runRecipeCommand', () => {
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

      expect(result.signal).toBe('SIGTERM')
    }
  )
})
