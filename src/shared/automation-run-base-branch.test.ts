import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAutomationRunBaseBranch } from './automation-run-base-branch'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  }).trim()
}

function commit(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), file)
  git(cwd, ['add', file])
  git(cwd, ['commit', '-q', '-m', file])
}

describe('resolveAutomationRunBaseBranch', () => {
  let root: string
  let checkout: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'orca-automation-base-'))
    const upstream = path.join(root, 'upstream')
    checkout = path.join(root, 'checkout')
    git(root, ['init', '-q', '-b', 'main', upstream])
    commit(upstream, 'pushed.txt')
    git(root, ['clone', '-q', upstream, checkout])
    // The user's local main is one unpushed commit ahead of origin/main.
    commit(checkout, 'unpushed.txt')
    git(checkout, ['branch', 'feature'])
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const probeCheckout = async (ref: string): Promise<boolean> => {
    try {
      git(checkout, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  it('starts a bare base from its remote-tracking ref so unpushed commits stay out', async () => {
    const base = await resolveAutomationRunBaseBranch('main', probeCheckout)

    expect(base).toBe('origin/main')
    expect(git(checkout, ['rev-list', '--count', `${base}..main`])).toBe('1')
  })

  it('keeps an explicit remote-tracking base unchanged', async () => {
    const probe = vi.fn(probeCheckout)

    await expect(resolveAutomationRunBaseBranch('origin/main', probe)).resolves.toBe('origin/main')
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps a local-only branch unchanged', async () => {
    await expect(resolveAutomationRunBaseBranch('feature', probeCheckout)).resolves.toBe('feature')
  })

  it('keeps a full ref unchanged', async () => {
    const probe = vi.fn(probeCheckout)

    await expect(resolveAutomationRunBaseBranch('refs/heads/main', probe)).resolves.toBe(
      'refs/heads/main'
    )
    expect(probe).not.toHaveBeenCalled()
  })

  it('leaves an unset base to the project default', async () => {
    const probe = vi.fn(probeCheckout)

    await expect(resolveAutomationRunBaseBranch(null, probe)).resolves.toBeUndefined()
    await expect(resolveAutomationRunBaseBranch(undefined, probe)).resolves.toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps the stored base when the remote ref probe fails', async () => {
    const base = await resolveAutomationRunBaseBranch('main', async () => {
      throw new Error('git unavailable')
    })

    expect(base).toBe('main')
  })
})
