import { describe, expect, it, vi } from 'vitest'
import { resolveWorktreeAddBaseRef } from './worktree-base-ref'

describe('resolveWorktreeAddBaseRef', () => {
  it('leaves fully qualified refs unchanged', async () => {
    const refExists = vi.fn()

    await expect(resolveWorktreeAddBaseRef('refs/heads/main', refExists)).resolves.toBe(
      'refs/heads/main'
    )

    expect(refExists).not.toHaveBeenCalled()
  })

  it('leaves provider review refs unchanged', async () => {
    const refExists = vi.fn()

    await expect(resolveWorktreeAddBaseRef('refs/pull/123/head', refExists)).resolves.toBe(
      'refs/pull/123/head'
    )
    await expect(
      resolveWorktreeAddBaseRef('refs/merge-requests/456/head', refExists)
    ).resolves.toBe('refs/merge-requests/456/head')

    expect(refExists).not.toHaveBeenCalled()
  })

  it('qualifies a bare local branch name', async () => {
    const refExists = vi.fn(async (ref: string) => ref === 'refs/heads/main')

    await expect(resolveWorktreeAddBaseRef('main', refExists)).resolves.toBe('refs/heads/main')

    expect(refExists).toHaveBeenCalledWith('refs/heads/main')
  })

  it('prefers a remote-tracking ref for remote-display names', async () => {
    const refExists = vi.fn(async (ref: string) => ref === 'refs/remotes/origin/main')

    await expect(resolveWorktreeAddBaseRef('origin/main', refExists)).resolves.toBe(
      'refs/remotes/origin/main'
    )

    expect(refExists).toHaveBeenCalledWith('refs/remotes/origin/main')
  })

  it('qualifies a slash-containing local branch when no matching remote ref exists', async () => {
    const refExists = vi.fn(async (ref: string) => ref === 'refs/heads/release/main')

    await expect(resolveWorktreeAddBaseRef('release/main', refExists)).resolves.toBe(
      'refs/heads/release/main'
    )

    expect(refExists.mock.calls.map((call) => call[0])).toEqual([
      'refs/remotes/release/main',
      'refs/heads/release/main'
    ])
  })

  it('keeps unresolvable revisions untouched', async () => {
    const refExists = vi.fn(async () => false)

    await expect(resolveWorktreeAddBaseRef('abc1234', refExists)).resolves.toBe('abc1234')
  })
})
