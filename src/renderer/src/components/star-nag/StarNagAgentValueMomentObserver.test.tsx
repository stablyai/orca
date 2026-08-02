// @vitest-environment happy-dom

import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { useAppStore } from '@/store'
import { StarNagAgentValueMomentObserver } from './StarNagAgentValueMomentObserver'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type StarNagApi = {
  agentValueMoment: ReturnType<typeof vi.fn>
  showAgentValueMoment: ReturnType<typeof vi.fn>
}

function setStarNagApi(api: StarNagApi): void {
  ;(window as unknown as { api: { starNag: StarNagApi } }).api = { starNag: api }
}

function entry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'Review this change',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey: 'tab-1:leaf-1',
    stateHistory: [],
    ...overrides
  }
}

function renderObserver(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<StarNagAgentValueMomentObserver />)
  })
  return { root, container }
}

function renderObserverWithProfiler(): {
  root: Root
  container: HTMLDivElement
  getRenderCount: () => number
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let renderCount = 0
  act(() => {
    root.render(
      <Profiler id="star-nag-observer" onRender={() => (renderCount += 1)}>
        <StarNagAgentValueMomentObserver />
      </Profiler>
    )
  })
  return { root, container, getRenderCount: () => renderCount }
}

function setAgentEntries(entries: Record<string, AgentStatusEntry>): void {
  act(() => {
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: entries,
      agentStatusEpoch: state.agentStatusEpoch + 1
    }))
  })
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('StarNagAgentValueMomentObserver', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let agentValueMoment: ReturnType<typeof vi.fn>
  let showAgentValueMoment: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ agentStatusByPaneKey: {}, agentStatusEpoch: 0 })
    agentValueMoment = vi.fn().mockResolvedValue({ status: 'ready', mode: 'gh' })
    showAgentValueMoment = vi.fn().mockResolvedValue(undefined)
    setStarNagApi({ agentValueMoment, showAgentValueMoment })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.useRealTimers()
  })

  it('asks main after a prompted non-interrupted done transition and idle window', async () => {
    ;({ root, container } = renderObserver())

    setAgentEntries({ pane: entry({ state: 'working' }) })
    setAgentEntries({ pane: entry({ state: 'done' }) })
    await act(async () => {
      vi.advanceTimersByTime(1200)
    })

    expect(agentValueMoment).toHaveBeenCalledTimes(1)
    expect(showAgentValueMoment).toHaveBeenCalledTimes(1)
  })

  it('does not scan 500 agent statuses on 50 same-state working pings', () => {
    const entries = Object.fromEntries(
      Array.from({ length: 500 }, (_unused, index) => [
        `pane-${index}`,
        entry({ paneKey: `tab-${index}:leaf-1` })
      ])
    )
    useAppStore.setState({ agentStatusByPaneKey: entries, agentStatusEpoch: 1 })
    const rendered = renderObserverWithProfiler()
    root = rendered.root
    container = rendered.container
    const initialRenders = rendered.getRenderCount()

    // Why: separate acts model separate hook pings; main produced 50 renders and
    // 25,000 completion-scan entry visits for this exact 500 x 50 scenario.
    for (let ping = 0; ping < 50; ping += 1) {
      act(() => {
        useAppStore.setState((state) => ({
          agentStatusByPaneKey: {
            ...state.agentStatusByPaneKey,
            'pane-0': entry({ paneKey: 'tab-0:leaf-1', updatedAt: ping + 2 })
          }
        }))
      })
    }
    expect(rendered.getRenderCount()).toBe(initialRenders)

    // A real transition bumps the epoch and must re-render.
    setAgentEntries({ pane: entry({ state: 'done', updatedAt: 100 }) })
    expect(rendered.getRenderCount()).toBeGreaterThan(initialRenders)
  })

  it('does not treat a removed and reused pane key as one completion transition', () => {
    ;({ root, container } = renderObserver())

    setAgentEntries({ pane: entry({ state: 'working' }) })
    setAgentEntries({})
    setAgentEntries({ pane: entry({ state: 'done', updatedAt: 2 }) })
    act(() => {
      vi.advanceTimersByTime(2400)
    })

    expect(agentValueMoment).not.toHaveBeenCalled()
    expect(showAgentValueMoment).not.toHaveBeenCalled()
  })

  it('ignores interrupted or empty-prompt completions', () => {
    ;({ root, container } = renderObserver())

    setAgentEntries({ pane: entry({ state: 'working', prompt: '' }) })
    setAgentEntries({ pane: entry({ state: 'done', prompt: '', interrupted: true }) })
    act(() => {
      vi.advanceTimersByTime(2400)
    })

    expect(agentValueMoment).not.toHaveBeenCalled()
    expect(showAgentValueMoment).not.toHaveBeenCalled()
  })

  it('waits for other live agents and recent typing to quiet', async () => {
    ;({ root, container } = renderObserver())

    setAgentEntries({
      done: entry({ state: 'working', paneKey: 'tab-1:leaf-1' }),
      active: entry({ state: 'working', paneKey: 'tab-2:leaf-1', prompt: 'Keep working' })
    })
    setAgentEntries({
      done: entry({ state: 'done', paneKey: 'tab-1:leaf-1' }),
      active: entry({ state: 'working', paneKey: 'tab-2:leaf-1', prompt: 'Keep working' })
    })
    await act(async () => {
      vi.advanceTimersByTime(1200)
    })
    expect(agentValueMoment).not.toHaveBeenCalled()
    expect(showAgentValueMoment).not.toHaveBeenCalled()

    setAgentEntries({
      done: entry({ state: 'done', paneKey: 'tab-1:leaf-1' }),
      active: entry({ state: 'done', paneKey: 'tab-2:leaf-1', prompt: 'Keep working' })
    })
    await act(async () => {
      vi.advanceTimersByTime(600)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
      vi.advanceTimersByTime(600)
    })
    expect(agentValueMoment).not.toHaveBeenCalled()
    expect(showAgentValueMoment).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1200)
    })

    expect(agentValueMoment).toHaveBeenCalledTimes(1)
    expect(showAgentValueMoment).toHaveBeenCalledTimes(1)
  })

  it('rechecks idle after main prepares the prompt', async () => {
    const preparation = createDeferred<{ status: 'ready'; mode: 'gh' }>()
    agentValueMoment.mockReturnValueOnce(preparation.promise)
    ;({ root, container } = renderObserver())

    setAgentEntries({ pane: entry({ state: 'working' }) })
    setAgentEntries({ pane: entry({ state: 'done' }) })

    await act(async () => {
      vi.advanceTimersByTime(1200)
    })
    expect(agentValueMoment).toHaveBeenCalledTimes(1)

    setAgentEntries({
      pane: entry({ state: 'done', paneKey: 'tab-1:leaf-1' }),
      active: entry({ state: 'working', paneKey: 'tab-2:leaf-1' })
    })
    await act(async () => {
      preparation.resolve({ status: 'ready', mode: 'gh' })
    })
    await act(async () => {
      vi.advanceTimersByTime(1200)
    })
    expect(showAgentValueMoment).not.toHaveBeenCalled()

    setAgentEntries({
      pane: entry({ state: 'done', paneKey: 'tab-1:leaf-1' }),
      active: entry({ state: 'done', paneKey: 'tab-2:leaf-1' })
    })
    await act(async () => {
      vi.advanceTimersByTime(1200)
    })

    expect(agentValueMoment).toHaveBeenCalledTimes(1)
    expect(showAgentValueMoment).toHaveBeenCalledTimes(1)
  })
})
