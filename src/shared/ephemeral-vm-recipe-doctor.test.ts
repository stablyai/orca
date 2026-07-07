import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { doctorEphemeralVmRecipe } from './ephemeral-vm-recipe-doctor'
import type { OrcaVmRecipe } from './types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeRepo(scripts: Record<string, { body?: string; mode?: number }>): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-vm-doctor-'))
  roots.push(root)
  for (const [relPath, opts] of Object.entries(scripts)) {
    const full = join(root, relPath)
    writeFileSync(full, opts.body ?? '#!/usr/bin/env bash\necho hi\n')
    if (opts.mode !== undefined) {
      chmodSync(full, opts.mode)
    }
  }
  return root
}

function checkById(
  result: ReturnType<typeof doctorEphemeralVmRecipe>,
  id: string
): { status: string } | undefined {
  return result.checks.find((check) => check.id === id)
}

function run(repoPath: string, recipe: OrcaVmRecipe): ReturnType<typeof doctorEphemeralVmRecipe> {
  return doctorEphemeralVmRecipe({
    repoPath,
    recipeId: recipe.id,
    recipes: [recipe],
    localExecutionSupported: true
  })
}

describe('doctorEphemeralVmRecipe', () => {
  it('passes a fully wired recipe with executable scripts', () => {
    const repo = makeRepo({
      'create.sh': { mode: 0o755 },
      'destroy.sh': { mode: 0o755 }
    })
    const result = run(repo, {
      id: 'cloud',
      name: 'Cloud',
      create: './create.sh',
      destroy: './destroy.sh'
    })
    expect(result.ok).toBe(true)
    expect(checkById(result, 'recipe.create')?.status).toBe('pass')
    expect(checkById(result, 'recipe.destroy')?.status).toBe('pass')
  })

  it('checks suspend and resume command paths when both are defined', () => {
    const repo = makeRepo({
      'create.sh': { mode: 0o755 },
      'suspend.sh': { mode: 0o755 },
      'resume.sh': { mode: 0o755 }
    })
    const result = run(repo, {
      id: 'cloud',
      name: 'Cloud',
      create: './create.sh',
      suspend: './suspend.sh',
      resume: './resume.sh',
      destroyDisabled: true
    })
    expect(checkById(result, 'recipe.suspend')?.status).toBe('pass')
    expect(checkById(result, 'recipe.resume')?.status).toBe('pass')
    expect(checkById(result, 'recipe.suspend_resume_pairing')).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  it('warns when only one of suspend/resume is defined (asymmetry strands the workspace)', () => {
    const repo = makeRepo({ 'create.sh': { mode: 0o755 }, 'suspend.sh': { mode: 0o755 } })
    const result = run(repo, {
      id: 'cloud',
      name: 'Cloud',
      create: './create.sh',
      suspend: './suspend.sh',
      destroyDisabled: true
    })
    expect(checkById(result, 'recipe.suspend_resume_pairing')?.status).toBe('warn')
    // warn never flips ok
    expect(result.ok).toBe(true)
  })

  it('warns (not fails) when a script exists but is not executable on POSIX', () => {
    if (process.platform === 'win32') {
      return
    }
    const repo = makeRepo({
      'create.sh': { mode: 0o644 },
      'destroy.sh': { mode: 0o755 }
    })
    const result = run(repo, {
      id: 'cloud',
      name: 'Cloud',
      create: './create.sh',
      destroy: './destroy.sh'
    })
    expect(checkById(result, 'recipe.create')?.status).toBe('warn')
    expect(result.ok).toBe(true)
  })

  it('fails when a referenced script does not exist', () => {
    const repo = makeRepo({ 'create.sh': { mode: 0o755 } })
    const result = run(repo, {
      id: 'cloud',
      name: 'Cloud',
      create: './create.sh',
      destroy: './missing.sh'
    })
    expect(checkById(result, 'recipe.destroy')?.status).toBe('fail')
    expect(result.ok).toBe(false)
  })
})
