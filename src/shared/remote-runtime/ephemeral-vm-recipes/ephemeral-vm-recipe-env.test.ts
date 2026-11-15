import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'

const tmpRoots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('runRecipeCommand passEnv', () => {
  async function runAndReadEnv(passEnv?: string[]): Promise<Record<string, string>> {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-vm-recipe-env-'))
    tmpRoots.push(repoPath)
    const scriptPath = join(repoPath, 'print-env.js')
    writeFileSync(scriptPath, 'process.stdout.write(JSON.stringify(process.env))\n')
    const result = await runRecipeCommand({
      command: `"${process.execPath}" "${scriptPath}"`,
      repoPath,
      context: { recipeId: 'remote-vm', repoPath },
      mode: 'create',
      resultSchemaVersion: 1,
      ...(passEnv ? { passEnv } : {})
    })
    expect(result.exitCode).toBe(0)
    return JSON.parse(result.stdout)
  }

  it('passes the full environment by default and only the allowlist with passEnv', async () => {
    vi.stubEnv('ORCA_TEST_RECIPE_API_KEY', 'secret-value')
    vi.stubEnv('ORCA_TEST_RECIPE_ALLOWED', 'allowed-value')

    const full = await runAndReadEnv()
    expect(full.ORCA_TEST_RECIPE_API_KEY).toBe('secret-value')

    const limited = await runAndReadEnv(['ORCA_TEST_RECIPE_ALLOWED'])
    expect(limited.ORCA_TEST_RECIPE_API_KEY).toBeUndefined()
    expect(limited.ORCA_TEST_RECIPE_ALLOWED).toBe('allowed-value')
    // Orca's own recipe variables are always set.
    expect(limited.ORCA_VM_MODE).toBe('create')
    expect(limited.ORCA_RECIPE_ID).toBe('remote-vm')
  })
})
