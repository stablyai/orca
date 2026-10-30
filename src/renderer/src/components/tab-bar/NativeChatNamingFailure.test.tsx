// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabHoverCard } from './TabHoverCard'
import { TAB_TOOLTIP_DELAY_MS, TabStripTooltipProvider } from './TabStripTooltipProvider'
import { NativeChatNamingErrorBlock } from './NativeChatNamingFailure'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
import { useNativeChatNamingFailure } from './use-native-chat-naming-failure'

const client = vi.hoisted(() => ({
  supported: false,
  web: false,
  emit: (_event: AgentSessionStatusEvent) => {},
  regenerate: vi.fn<() => Promise<boolean>>()
}))
const settings = vi.hoisted(() => ({
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => settings }
}))
vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => client.web
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: async (_target: unknown, emit: typeof client.emit) => {
    client.emit = emit
    return { unsubscribe: () => {} }
  },
  regenerateStructuredAgentSessionName: client.regenerate
}))

vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () =>
    client.supported ? 'supported' : 'unsupported'
}))

const FAILURE = {
  sessionId: 'session-1',
  executionHostId: 'local',
  error: { message: 'Invalid API key', failedAt: 5 }
}

function ChatTab(): React.JSX.Element {
  const naming = useNativeChatNamingFailure(FAILURE)
  return (
    <TabHoverCard
      title="Repair the login flow"
      icon={<span />}
      programName="Claude"
      alert={
        naming
          ? (dismiss) => <NativeChatNamingErrorBlock naming={naming} onDismiss={dismiss} />
          : undefined
      }
    >
      <button>chat tab</button>
    </TabHoverCard>
  )
}

async function hoverChatTab(): Promise<void> {
  render(
    <TabStripTooltipProvider>
      <ChatTab />
    </TabStripTooltipProvider>
  )
  await act(async () => {})
  fireEvent.pointerMove(screen.getByRole('button', { name: 'chat tab' }), { pointerType: 'mouse' })
  act(() => vi.advanceTimersByTime(TAB_TOOLTIP_DELAY_MS))
}

describe('chat tab naming failure', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    client.regenerate.mockResolvedValue(true)
  })
  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.useRealTimers()
  })

  it.each([
    { supported: true, web: false },
    { supported: false, web: false },
    { supported: true, web: true },
    { supported: false, web: true }
  ])(
    'shows recovery actions for host regeneration support=$supported, web=$web',
    async ({ supported, web }) => {
      client.supported = supported
      client.web = web
      await hoverChatTab()
      expect(screen.getAllByText("Couldn't name this chat").length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: 'view error' }).length).toBeGreaterThan(0)
      const settingsButtons = screen.queryAllByRole('button', { name: 'Settings' })
      expect(settingsButtons.length > 0).toBe(!web)
      const regenerate = screen.queryAllByRole('button', { name: 'Regenerate name' })
      expect(regenerate.length > 0).toBe(supported)
      if (supported) {
        const acceptance = Promise.withResolvers<boolean>()
        client.regenerate.mockReturnValueOnce(acceptance.promise)
        fireEvent.click(regenerate[0])
        act(() =>
          client.emit({ type: 'snapshot', sessions: [], namingActiveSessionIds: ['session-1'] })
        )
        expect(client.regenerate).toHaveBeenCalledWith({ kind: 'local' }, 'session-1')
        expect(screen.getAllByRole('button', { name: 'Regenerating…' })[0]).toHaveProperty(
          'disabled',
          true
        )
        act(() => client.emit({ type: 'snapshot', sessions: [], namingActiveSessionIds: [] }))
        await act(async () => acceptance.resolve(true))
        expect(screen.queryAllByRole('button', { name: 'Regenerating…' })).toHaveLength(0)
      }
      if (!web) {
        settings.openSettingsPage.mockImplementationOnce(() => {
          expect(screen.queryByText("Couldn't name this chat")).toBeNull()
        })
        fireEvent.click(settingsButtons[0])
        expect(screen.queryByText("Couldn't name this chat")).toBeNull()
        expect(settings.openSettingsPage).toHaveBeenCalledOnce()
        expect(settings.openSettingsTarget).toHaveBeenCalledExactlyOnceWith({
          pane: 'chat',
          repoId: null,
          sectionId: 'chat-names'
        })
        fireEvent.pointerLeave(screen.getByRole('button', { name: 'chat tab' }))
        fireEvent.pointerMove(screen.getByRole('button', { name: 'chat tab' }), {
          pointerType: 'mouse'
        })
        act(() => vi.advanceTimersByTime(TAB_TOOLTIP_DELAY_MS))
        expect(screen.getAllByText("Couldn't name this chat").length).toBeGreaterThan(0)
      }
    }
  )
})
