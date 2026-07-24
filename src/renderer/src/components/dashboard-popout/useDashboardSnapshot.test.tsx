// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { useDashboardSnapshot } from './useDashboardSnapshot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function card(overrides: Partial<DashboardCard>): DashboardCard {
  return {
    paneKey: 'pk',
    ptyId: 'p1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 't',
    repoId: 'r1',
    worktreeId: 'w1',
    tabId: 'tab1',
    leafId: 'l1',
    repoName: 'Repo',
    worktreeName: 'wt',
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false,
    ...overrides
  }
}

function snapshot(cards: DashboardCard[]): DashboardSnapshot {
  return { generatedAt: 1, cards }
}

let apply: (next: DashboardSnapshot) => void
const startViewTransition = vi.fn((cb: () => void) => {
  cb()
  return {
    finished: Promise.resolve(),
    ready: Promise.resolve(),
    updateCallbackDone: Promise.resolve()
  }
})

/** A Radix dialog marks its open content with role + data-state; mimic that so
 *  the hook's top-layer-conflict guard sees an "open terminal". */
function openTerminalDialog(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('role', 'dialog')
  el.setAttribute('data-state', 'open')
  document.body.appendChild(el)
  return el
}

describe('useDashboardSnapshot', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      dashboard: {
        onSnapshot: (cb: (next: DashboardSnapshot) => void) => {
          apply = cb
          return () => {}
        },
        requestSnapshot: vi.fn(async () => {})
      }
    }
    ;(document as unknown as { startViewTransition: unknown }).startViewTransition =
      startViewTransition
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof matchMedia
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('runs a view transition when a card changes column', () => {
    const { result } = renderHook(() => useDashboardSnapshot())
    act(() => apply(snapshot([card({ bucket: 'idle' })])))
    startViewTransition.mockClear() // ignore the initial populate

    act(() => apply(snapshot([card({ bucket: 'working' })])))
    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(result.current.cards[0].bucket).toBe('working')
  })

  it('skips the view transition — but still applies the update — while the terminal dialog is open', () => {
    const { result } = renderHook(() => useDashboardSnapshot())
    act(() => apply(snapshot([card({ bucket: 'idle' })])))
    startViewTransition.mockClear() // ignore the initial populate
    openTerminalDialog()

    act(() => apply(snapshot([card({ bucket: 'working' })])))
    // Why: the card's View Transition snapshot would paint in the browser top
    // layer, above the z-50 dialog — so we jump instead of morphing.
    expect(startViewTransition).not.toHaveBeenCalled()
    expect(result.current.cards[0].bucket).toBe('working')
  })
})
