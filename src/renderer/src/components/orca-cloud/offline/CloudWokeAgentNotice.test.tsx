// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import {
  AGENT_RELAUNCH_GRACE_MS,
  AGENT_RELAUNCH_WATCH_MS
} from '@/lib/orca-cloud/cloud-woke-agent-strip'
import { CloudWokeAgentNotice } from './CloudWokeAgentNotice'

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_slot: string, name: string) =>
      String(params?.[name] ?? '')
    )
}))
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
)

const paneKey = 'tab-1:leaf-1'
const asleepAt = 1_000_000

function setAgentRow(
  row: Pick<AgentStatusEntry, 'evidenceObservedAt'> & { updatedAt?: number }
): void {
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: '',
    stateStartedAt: asleepAt,
    paneKey,
    stateHistory: [],
    agentType: 'claude',
    ...(row.evidenceObservedAt === undefined ? {} : { evidenceObservedAt: row.evidenceObservedAt }),
    updatedAt: row.updatedAt ?? asleepAt
  }
  useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: entry } })
}

/** A pane whose screen the test controls: at a shell prompt or not, and when it redraws. */
function renderNotice(atShellPrompt: boolean) {
  const pane = { atShellPrompt, listeners: new Set<() => void>() }
  const onRestart = vi.fn()
  const onDismiss = vi.fn()
  render(
    <CloudWokeAgentNotice
      paneKey={paneKey}
      paneLeafId="leaf-1"
      agentName="Claude"
      capturedAt={asleepAt}
      paneAtShellPrompt={() => pane.atShellPrompt}
      subscribeScreen={(onChange) => {
        pane.listeners.add(onChange)
        return () => pane.listeners.delete(onChange)
      }}
      onRestart={onRestart}
      onDismiss={onDismiss}
    />
  )
  const redraw = (atPrompt: boolean): void => {
    pane.atShellPrompt = atPrompt
    act(() => pane.listeners.forEach((listener) => listener()))
  }
  return { onRestart, onDismiss, redraw }
}

const restartButton = () => screen.queryByRole('button', { name: 'Restart Claude' })
const pastGrace = () => act(() => vi.advanceTimersByTime(AGENT_RELAUNCH_GRACE_MS))

beforeEach(() => {
  vi.useFakeTimers()
  setAgentRow({ evidenceObservedAt: asleepAt - 5_000, updatedAt: asleepAt - 5_000 })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CloudWokeAgentNotice (RA-WAKE)', () => {
  it('relaunched by the host: no bar at any point, and the hint is dismissed', () => {
    const { onDismiss } = renderNotice(true)
    expect(restartButton()).toBeNull()
    act(() => setAgentRow({ evidenceObservedAt: asleepAt + 120_000 }))
    expect(onDismiss).toHaveBeenCalled()
    pastGrace()
    expect(restartButton()).toBeNull()
  })

  it('not relaunched after the grace, at a bare shell: Restart Claude', () => {
    const { onRestart, onDismiss } = renderNotice(true)
    expect(restartButton()).toBeNull()
    pastGrace()
    fireEvent.click(restartButton()!)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  // Design-squad (1): the reconnect replay is not a relaunch.
  it("a reconnect's replayed row (fresh updatedAt, pre-sleep evidence) is not a relaunch", () => {
    const { onDismiss } = renderNotice(true)
    act(() => setAgentRow({ evidenceObservedAt: asleepAt - 5_000, updatedAt: asleepAt + 120_000 }))
    expect(onDismiss).not.toHaveBeenCalled()
    pastGrace()
    expect(restartButton()).not.toBeNull()
  })

  // Design-squad (2): Restart shown, then the hook arrives: straight to no bar.
  it('a relaunch that reports in after Restart was offered takes the bar away in one step', () => {
    const { onDismiss } = renderNotice(true)
    pastGrace()
    expect(restartButton()).not.toBeNull()
    act(() => setAgentRow({ evidenceObservedAt: asleepAt + 120_000 }))
    expect(restartButton()).toBeNull()
    expect(screen.queryByText('Woke up · processes stopped while asleep')).toBeNull()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  // Design-squad (3): an ambiguous screen at the grace that falls back to a shell later.
  it('a non-shell screen at the grace that later drops to a shell then offers Restart', () => {
    const { onDismiss, redraw } = renderNotice(false)
    pastGrace()
    expect(restartButton()).toBeNull()
    expect(onDismiss).not.toHaveBeenCalled()
    redraw(true)
    expect(restartButton()).not.toBeNull()
  })

  it('a non-shell screen through the whole watch: never a bar, then the hint lets go', () => {
    const { onDismiss, redraw } = renderNotice(false)
    pastGrace()
    redraw(false)
    expect(restartButton()).toBeNull()
    act(() => vi.advanceTimersByTime(AGENT_RELAUNCH_WATCH_MS - AGENT_RELAUNCH_GRACE_MS))
    expect(restartButton()).toBeNull()
    expect(onDismiss).toHaveBeenCalled()
  })
})
