// @vitest-environment happy-dom
// CHAT-BANNERS: toggling a pane's chat view moves (remounts) its woke-up bar, which restarts the
// bar's relaunch grace. A remount must never show the bar over an agent that has already
// relaunched: that is decided from the agent's evidence, never from the grace (design-squad).
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  AGENT_RELAUNCH_GRACE_MS,
  AGENT_RELAUNCH_WATCH_MS
} from '@/lib/orca-cloud/cloud-woke-agent-strip'
import { CloudWokeAgentNotice } from '../orca-cloud/offline/CloudWokeAgentNotice'
import { CloudChatBannerSlot } from './CloudChatBannerSlot'
import { CloudPaneBannerPortal } from './CloudPaneBannerPortal'
import { resetCloudChatBannerSlotsForTest } from './cloud-chat-banner-slot'

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

function setEvidence(evidenceObservedAt: number): void {
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: '',
    stateStartedAt: asleepAt,
    paneKey,
    stateHistory: [],
    agentType: 'claude',
    evidenceObservedAt,
    updatedAt: evidenceObservedAt
  }
  useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: entry } })
}

/** The pane's woke bar, with the chat view open (its column's slot) or closed. */
function view(chatOpen: boolean, container: HTMLElement, onDismiss: () => void) {
  const pane: Pick<ManagedPane, 'container'> = { container }
  return (
    <>
      {chatOpen ? <CloudChatBannerSlot paneKey={paneKey} /> : null}
      <CloudPaneBannerPortal pane={pane} paneKey={paneKey} portalKey="woke">
        <CloudWokeAgentNotice
          paneKey={paneKey}
          paneLeafId="leaf-1"
          agentName="Claude"
          capturedAt={asleepAt}
          // A bare shell: the bar would offer Restart if the agent had not reported in.
          paneAtShellPrompt={() => true}
          subscribeScreen={() => () => undefined}
          onRestart={() => undefined}
          onDismiss={onDismiss}
        />
      </CloudPaneBannerPortal>
    </>
  )
}

const restartButton = () => screen.queryByRole('button', { name: 'Restart Claude' })
const pastWatch = () => act(() => vi.advanceTimersByTime(AGENT_RELAUNCH_WATCH_MS))

beforeEach(() => {
  vi.useFakeTimers()
  setEvidence(asleepAt - 5_000)
})
afterEach(() => {
  cleanup()
  resetCloudChatBannerSlotsForTest()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('toggling the chat view over a woke-up bar', () => {
  it('an agent that relaunched stays without a bar through every toggle, past the grace', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const onDismiss = vi.fn()
    const { rerender } = render(view(true, container, onDismiss))
    act(() => setEvidence(asleepAt + 60_000))
    expect(onDismiss).toHaveBeenCalled()
    for (const chatOpen of [false, true, false]) {
      rerender(view(chatOpen, container, onDismiss))
      expect(restartButton()).toBeNull()
      pastWatch()
      expect(restartButton()).toBeNull()
    }
  })

  it('a relaunch that reports while Restart shows: toggled, the bar does not come back', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const onDismiss = vi.fn()
    const { rerender } = render(view(false, container, onDismiss))
    act(() => vi.advanceTimersByTime(AGENT_RELAUNCH_GRACE_MS))
    expect(restartButton()).not.toBeNull()
    act(() => setEvidence(asleepAt + 60_000))
    expect(restartButton()).toBeNull()
    rerender(view(true, container, onDismiss))
    pastWatch()
    expect(restartButton()).toBeNull()
  })

  it('no relaunch: after a toggle the bar returns once the grace has passed again', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { rerender } = render(view(false, container, () => undefined))
    act(() => vi.advanceTimersByTime(AGENT_RELAUNCH_GRACE_MS))
    expect(restartButton()).not.toBeNull()
    rerender(view(true, container, () => undefined))
    act(() => vi.advanceTimersByTime(AGENT_RELAUNCH_GRACE_MS))
    const slot = document.querySelector('[data-cloud-chat-banners]')
    expect(slot?.contains(restartButton())).toBe(true)
  })
})
