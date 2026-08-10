import { describe, expect, it } from 'vitest'
import {
  WORKTREE_CREATE_TIMEOUT_DEFAULTS,
  getMaximumWorktreeCreateTransportTimeoutMs,
  getWorktreeCreateTransportTimeoutMs,
  normalizeWorktreeCreateTimeoutOverrides,
  normalizeWorktreeCreateTimeouts,
  resolveWorktreeCreateTimeouts
} from './worktree-create-timeouts'

describe('worktree create timeouts', () => {
  it('exports the built-in defaults', () => {
    expect(WORKTREE_CREATE_TIMEOUT_DEFAULTS).toEqual({
      refreshBaseRefMs: 60_000,
      addCheckoutMs: 180_000,
      registrationMs: 30_000,
      materializationMs: 300_000
    })
  })

  it('normalizes complete values against a fieldwise fallback', () => {
    expect(
      normalizeWorktreeCreateTimeouts(
        {
          refreshBaseRefMs: 999,
          addCheckoutMs: 7_200_001,
          registrationMs: 2_500.4,
          materializationMs: Number.NaN
        },
        {
          refreshBaseRefMs: 10_000,
          addCheckoutMs: 20_000,
          registrationMs: 30_000,
          materializationMs: 40_000
        }
      )
    ).toEqual({
      refreshBaseRefMs: 1_000,
      addCheckoutMs: 7_200_000,
      registrationMs: 2_500,
      materializationMs: 40_000
    })
  })

  it('keeps repo and request overrides sparse', () => {
    expect(
      normalizeWorktreeCreateTimeoutOverrides({
        refreshBaseRefMs: 999,
        addCheckoutMs: -1,
        registrationMs: 2_500.6,
        materializationMs: Number.POSITIVE_INFINITY,
        unknownMs: 45_000
      })
    ).toEqual({
      refreshBaseRefMs: 1_000,
      registrationMs: 2_501
    })
    expect(normalizeWorktreeCreateTimeoutOverrides({ addCheckoutMs: 0 })).toBeUndefined()
    expect(normalizeWorktreeCreateTimeoutOverrides(null)).toBeUndefined()
  })

  it('resolves request, repo, global, and defaults fieldwise', () => {
    expect(
      resolveWorktreeCreateTimeouts({
        global: {
          refreshBaseRefMs: 70_000,
          addCheckoutMs: 200_000
        },
        repo: {
          addCheckoutMs: 210_000,
          registrationMs: 35_000
        },
        request: {
          registrationMs: 40_000,
          materializationMs: 600_000
        }
      })
    ).toEqual({
      refreshBaseRefMs: 70_000,
      addCheckoutMs: 210_000,
      registrationMs: 40_000,
      materializationMs: 600_000
    })
  })

  it('adds transport headroom to resolved and maximum stage budgets', () => {
    expect(getWorktreeCreateTransportTimeoutMs(WORKTREE_CREATE_TIMEOUT_DEFAULTS)).toBe(600_000)
    expect(getMaximumWorktreeCreateTransportTimeoutMs()).toBe(28_830_000)
  })
})
