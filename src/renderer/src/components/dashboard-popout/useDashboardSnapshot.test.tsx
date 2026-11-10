// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'

import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
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
let applyStatus: (next: AgentStatusIpcPayload) => void
let applyClear: (next: AgentStatusClearIpcPayload) => void
const requestSnapshot = vi.fn(async () => {})
let readyRejection: unknown = null
let hideDocumentAfterTransitionStart = false
const startViewTransition = vi.fn((cb: () => void) => {
  cb()
  if (hideDocumentAfterTransitionStart) {
    hideDocument()
  }
  return {
    finished: Promise.resolve(),
    ready: readyRejection !== null ? Promise.reject(readyRejection) : Promise.resolve(),
    updateCallbackDone: Promise.resolve()
  }
})

const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState')

function hideDocument(): void {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
}

/** Mimic Radix’s open-dialog attributes so the top-layer conflict guard recognizes the terminal. */

describe('useDashboardSnapshot', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      dashboard: {
        onSnapshot: (cb: (next: DashboardSnapshot) => void) => {
          apply = cb
          return () => {}
        },
        requestSnapshot
      },
      agentStatus: {
        onSet: (cb: (next: AgentStatusIpcPayload) => void) => {
          applyStatus = cb
          return () => {}
        },
        onClear: (cb: (next: AgentStatusClearIpcPayload) => void) => {
          applyClear = cb
          return () => {}
        }
      }
    }
    ;(document as unknown as { startViewTransition: unknown }).startViewTransition =
      startViewTransition
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof matchMedia
  })
  afterEach(() => {
    document.body.innerHTML = ''
    readyRejection = null
    hideDocumentAfterTransitionStart = false
    if (originalVisibilityState) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityState)
    } else {
      Reflect.deleteProperty(document, 'visibilityState')
    }
    vi.clearAllMocks()
  })

  it('trailing-debounces an unknown-pane burst into one topology refresh', () => {
    vi.useFakeTimers()
    renderHook(() => useDashboardSnapshot())
    act(() => apply(snapshot([card({})])))
    requestSnapshot.mockClear()

    act(() => {
      for (let index = 0; index < 10; index += 1) {
        applyStatus({
          paneKey: `unknown-${index}`,
          state: 'working',
          prompt: '',
          connectionId: null,
          receivedAt: 300 + index,
          stateStartedAt: 250 + index
        })
        vi.advanceTimersByTime(40)
      }
      applyClear({ paneKey: 'pk' })
      vi.advanceTimersByTime(249)
    })

    expect(requestSnapshot).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('refreshes within the max wait while unknown events continue', () => {
    vi.useFakeTimers()
    renderHook(() => useDashboardSnapshot())
    act(() => apply(snapshot([card({})])))
    requestSnapshot.mockClear()

    const unknown = (index: number): void =>
      applyStatus({
        paneKey: `unknown-${index}`,
        state: 'working',
        prompt: '',
        connectionId: null,
        receivedAt: 300 + index,
        stateStartedAt: 250 + index
      })
    act(() => {
      unknown(0)
      for (let index = 1; index <= 4; index += 1) {
        vi.advanceTimersByTime(200)
        unknown(index)
      }
    })
    expect(requestSnapshot).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(200))
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
