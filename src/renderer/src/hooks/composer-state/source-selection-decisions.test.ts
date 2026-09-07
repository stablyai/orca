import { describe, expect, it, vi } from 'vitest'
import type { GitHubPrStartPoint } from '../../../../shared/worktree/types'
import {
  resolveGitHubPrStartPointSelection,
  type SmartGitHubPrStartPointSelection
} from './source-selection-decisions'

function selection(): SmartGitHubPrStartPointSelection {
  return {
    repoId: 'repo-1',
    item: {
      id: 'pr-17128',
      type: 'pr',
      number: 17128,
      title: 'Fix terminal recovery',
      state: 'merged',
      url: 'https://github.com/stablyai/orca/pull/17128',
      labels: [],
      updatedAt: '2026-08-29T09:27:45.000Z',
      author: 'octocat',
      repoId: 'repo-1'
    }
  }
}

describe('resolveGitHubPrStartPointSelection', () => {
  it('returns the completed selection without resolving again', async () => {
    const target = selection()
    target.resolved = { baseBranch: 'cached-head' }
    const resolve = vi.fn<() => Promise<GitHubPrStartPoint>>()

    await expect(resolveGitHubPrStartPointSelection(target, resolve)).resolves.toEqual({
      baseBranch: 'cached-head'
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('shares an in-flight selection resolution with submit', async () => {
    let release!: (value: GitHubPrStartPoint) => void
    const pending = new Promise<GitHubPrStartPoint>((resolve) => {
      release = resolve
    })
    const resolve = vi.fn(() => pending)
    const target = selection()

    const eager = resolveGitHubPrStartPointSelection(target, resolve)
    const submit = resolveGitHubPrStartPointSelection(target, resolve)
    release({ baseBranch: 'resolved-head' })

    await expect(Promise.all([eager, submit])).resolves.toEqual([
      { baseBranch: 'resolved-head' },
      { baseBranch: 'resolved-head' }
    ])
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(target).toMatchObject({ resolved: { baseBranch: 'resolved-head' } })
    expect(target.pendingResolution).toBeUndefined()
  })

  it('clears a failed pending resolution so create can retry', async () => {
    const resolve = vi
      .fn<() => Promise<GitHubPrStartPoint>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ baseBranch: 'retry-head' })
    const target = selection()

    await expect(resolveGitHubPrStartPointSelection(target, resolve)).rejects.toThrow(
      'fetch failed'
    )
    await expect(resolveGitHubPrStartPointSelection(target, resolve)).resolves.toEqual({
      baseBranch: 'retry-head'
    })

    expect(resolve).toHaveBeenCalledTimes(2)
  })
})
