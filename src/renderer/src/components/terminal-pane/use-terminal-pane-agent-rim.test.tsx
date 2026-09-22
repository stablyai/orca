// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useTerminalPaneAgentRim } from './use-terminal-pane-agent-rim'

const applyMock = vi.hoisted(() => vi.fn())
const subscribeMock = vi.hoisted(() => vi.fn(() => () => {}))

vi.mock('./agent-pane-rim-subscriptions', () => ({
  applyAgentPaneRimToManager: applyMock,
  subscribeAgentPaneRim: subscribeMock
}))

afterEach(() => {
  applyMock.mockClear()
  subscribeMock.mockClear()
})

function useHarness(props: { tabId: string; cwd: string; paneCount: number }) {
  const managerRef = useRef<PaneManager | null>({} as PaneManager)
  useTerminalPaneAgentRim({ managerRef, ...props })
}

describe('useTerminalPaneAgentRim', () => {
  it('re-applies the rim when the cwd changes even if the pane count is unchanged', () => {
    // Why: a same-tab cwd update rebuilds the pane manager (mount lifecycle deps [tabId, cwd]);
    // a replacement manager with the same pane count would otherwise miss its rim attribute.
    const { rerender } = renderHook((props) => useHarness(props), {
      initialProps: { tabId: 'tab-1', cwd: '/repo/a', paneCount: 1 }
    })
    expect(applyMock).toHaveBeenCalledTimes(1)

    rerender({ tabId: 'tab-1', cwd: '/repo/b', paneCount: 1 })

    expect(applyMock).toHaveBeenCalledTimes(2)
  })

  it('re-applies the rim when the pane count changes', () => {
    const { rerender } = renderHook((props) => useHarness(props), {
      initialProps: { tabId: 'tab-1', cwd: '/repo/a', paneCount: 1 }
    })
    applyMock.mockClear()

    rerender({ tabId: 'tab-1', cwd: '/repo/a', paneCount: 2 })

    expect(applyMock).toHaveBeenCalledTimes(1)
  })
})
