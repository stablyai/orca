// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS } from '@/store/slices/pane-foreground-agent'
import {
  earliestPaneForegroundAgentEvidenceExpiry,
  usePaneForegroundAgentEvidenceExpiryTick
} from './use-pane-foreground-agent-evidence-expiry'

describe('earliestPaneForegroundAgentEvidenceExpiry', () => {
  it('returns the earliest future expiry and ignores agent-less, unstamped, and expired entries', () => {
    const now = 100_000
    expect(
      earliestPaneForegroundAgentEvidenceExpiry(
        {
          a: { agent: 'claude', shellForeground: false, observedAt: now - 1_000 },
          b: { agent: 'codex', shellForeground: false, observedAt: now - 500 },
          shell: { agent: null, shellForeground: true, observedAt: now },
          unstamped: { agent: 'claude', shellForeground: false },
          expired: {
            agent: 'claude',
            shellForeground: false,
            observedAt: now - PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS
          }
        },
        now
      )
    ).toBe(now - 1_000 + PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS)
  })

  it('returns null when no entry has a future expiry', () => {
    expect(earliestPaneForegroundAgentEvidenceExpiry({}, 1_000)).toBeNull()
  })
})

describe('usePaneForegroundAgentEvidenceExpiryTick', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bumps once when the only evidence entry crosses its TTL', () => {
    const entries = {
      pane: { agent: 'claude' as const, shellForeground: false, observedAt: Date.now() }
    }
    const { result } = renderHook(() => usePaneForegroundAgentEvidenceExpiryTick(entries))

    expect(result.current).toBe(0)
    act(() => {
      vi.advanceTimersByTime(PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS + 1)
    })
    expect(result.current).toBe(1)

    // Why: past the TTL there is no future expiry left, so no timer re-arms.
    act(() => {
      vi.advanceTimersByTime(PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS + 1)
    })
    expect(result.current).toBe(1)
  })

  it('schedules nothing for entries without attributable evidence', () => {
    const entries = {
      pane: { agent: null, shellForeground: true, observedAt: Date.now() }
    }
    const { result } = renderHook(() => usePaneForegroundAgentEvidenceExpiryTick(entries))

    act(() => {
      vi.advanceTimersByTime(PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS * 2)
    })
    expect(result.current).toBe(0)
  })
})
