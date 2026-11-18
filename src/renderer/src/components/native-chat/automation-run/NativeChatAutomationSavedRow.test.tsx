// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import { notifyWebhooksChanged } from '@/components/bots/webhooks/use-webhook-data'
import { MessageRow } from '../messages/rows/NativeChatMessageRow'
import { createNativeChatMessageListProjection } from '../conversation/projection/native-chat-message-list-projection'
import { buildNativeChatTranscriptSlots } from '../conversation/slots/native-chat-transcript-slots'
import { isAdmissibleAgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-schemas'
import { projectStructuredItemToNativeChat } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { projectStructuredOrcaCardItem } from '../../../../../shared/structured-automation-saved-projection'
import { nativeChatTurnFoldRow } from '../../../../../shared/native-chat/transcript/folding/native-chat-turn-fold'
import { isNoiseMessage } from '../../../../../shared/native-chat/transcript/messages/native-chat-noise'
import { nativeChatRowSpeaksOrActs } from '../../../../../shared/native-chat/transcript/folding/native-chat-trailing-run'

// The app's root provides tooltips (the timestamp's); a card alone needs its own.
const renderCard = (saved: Saved) =>
  render(
    <TooltipProvider>
      <NativeChatAutomationSavedRow saved={saved} timestamp={1_000} />
    </TooltipProvider>
  )

const { openBotAutomation, callWebhookHost, copyWebhookSecret } = vi.hoisted(() => ({
  openBotAutomation: vi.fn(),
  callWebhookHost: vi.fn(),
  copyWebhookSecret: vi.fn()
}))
vi.mock('@/components/bots/bot-automation-open', () => ({ openBotAutomation }))
vi.mock('@/components/bots/webhooks/webhook-host-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callWebhookHost
}))
vi.mock('@/components/bots/webhooks/webhook-secret-copy', () => ({ copyWebhookSecret }))
beforeEach(() => callWebhookHost.mockImplementation(hostAnswer))

afterEach(() => {
  cleanup()
  openBotAutomation.mockReset()
  callWebhookHost.mockReset().mockImplementation(hostAnswer)
  copyWebhookSecret.mockReset()
  hookState = 'live'
})

type Saved = NonNullable<NativeChatMessage['automationSaved']>

const DAILY: Saved = {
  change: 'created',
  automation: {
    id: 'auto-1',
    name: 'Morning digest',
    enabled: true,
    nextRunAt: 2_000,
    updatedAt: 1_000,
    dtstart: 1_000,
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    workspaceId: 'folder:fw-1',
    bot: { botId: 'bot-1' }
  },
  resultsTo: 'chat'
}

let hookState = 'live'
const hostAnswer = (_target: unknown, method: string) =>
  Promise.resolve(
    method === 'webhooks.card'
      ? { hookId: 'wh_7Kx2pQ9mZbV4tL1r', state: hookState }
      : { key: 'k', url: 'https://hooks.test/hooks/wh_7Kx2pQ9mZbV4tL1r/k' }
  )

const OWNER = { target: { kind: 'local' }, sessionId: 's1', worktreeId: 'folder:fw-1' } as const

const renderInChat = (saved: Saved) =>
  render(
    <TooltipProvider>
      <NativeChatVisualOwnerContext.Provider value={OWNER}>
        <NativeChatAutomationSavedRow saved={saved} timestamp={1_000} />
      </NativeChatVisualOwnerContext.Provider>
    </TooltipProvider>
  )

const HOOKED: Saved = {
  change: 'created',
  automation: {
    ...DAILY.automation,
    ...EVENT_ONLY_SCHEDULE,
    on: [{ id: 'wh-wh_7Kx2pQ9mZbV4tL1r', source: 'webhook', event: 'call' }]
  },
  resultsTo: 'chat'
}

describe('NativeChatAutomationSavedRow', () => {
  // The URL carries the hook's key, so it's read on click and never kept in the transcript.
  it("copies a webhook automation's full URL, read from its host on click", async () => {
    hookState = 'live'
    renderInChat(HOOKED)
    expect(callWebhookHost).not.toHaveBeenCalledWith(
      expect.anything(),
      'webhooks.reveal',
      expect.anything()
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Copy URL' }))
    await vi.waitFor(() =>
      expect(copyWebhookSecret).toHaveBeenCalledWith(
        'https://hooks.test/hooks/wh_7Kx2pQ9mZbV4tL1r/k',
        'URL copied'
      )
    )
    expect(callWebhookHost).toHaveBeenCalledWith({ kind: 'local' }, 'webhooks.reveal', {
      hookId: 'wh_7Kx2pQ9mZbV4tL1r'
    })
  })

  // No bot step: the shared hook read polls, and the button fills in once Orca Cloud takes the hook.
  it("says it's getting the URL until the hook is live, then offers Copy URL", async () => {
    hookState = 'pending'
    renderInChat(HOOKED)
    const waiting = await screen.findByRole('button', { name: 'Getting the URL…' })
    expect(waiting).toBeDisabled()
    hookState = 'live'
    notifyWebhooksChanged()
    expect(await screen.findByRole('button', { name: 'Copy URL' })).toBeEnabled()
  })

  it('offers Copy URL on an edit that made a hook, and never without one', async () => {
    renderInChat({ ...HOOKED, change: 'updated' })
    expect(await screen.findByRole('button', { name: 'Copy URL' })).toBeVisible()
    cleanup()
    renderInChat(DAILY)
    expect(screen.queryByRole('button', { name: 'Copy URL' })).toBeNull()
  })

  it('opens the automation on the Automations page', () => {
    renderCard(DAILY)
    fireEvent.click(screen.getByRole('button', { name: /Morning digest/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open automation' }))
    expect(openBotAutomation).toHaveBeenCalledWith('auto-1', null)
  })
})

describe('an automation-saved journal item', () => {
  const item = {
    itemId: 'saved:auto-1',
    revision: 1,
    sequence: 2,
    observedAt: 1_000,
    body: { kind: 'automation-saved', ...DAILY }
  }

  it('reloads into a drawn card that outlives its turn and never ends a tool run', () => {
    const reloaded: unknown = JSON.parse(JSON.stringify(item))
    if (!isAdmissibleAgentJournalRenderItem(reloaded)) {
      throw new Error('automation-saved item did not survive admission')
    }
    const message = projectStructuredOrcaCardItem(reloaded)
    if (!message) {
      throw new Error('automation-saved item did not project')
    }
    expect(message).toMatchObject({ role: 'system', automationSaved: DAILY, timestamp: 1_000 })
    expect(nativeChatTurnFoldRow(message, 'turn', false)).toMatchObject({
      draws: true,
      outlivesTurn: true
    })
    expect(isNoiseMessage(message)).toBe(false)
    expect(nativeChatRowSpeaksOrActs(message, true, new Map())).toBe(false)
    // The default projection draws nothing for it; the desktop's and the phone's draw it.
    expect(projectStructuredItemToNativeChat(reloaded)).toBeNull()

    const messages = createNativeChatMessageListProjection()([message]).conversation
    const slots = buildNativeChatTranscriptSlots({
      messages,
      turnKeys: messages.map(() => undefined),
      liveTurnKey: undefined,
      receipts: new Map(),
      turnStatuses: { active: null, completedByTurn: {} },
      turnDiffs: new Map(),
      expandedTurnKeys: new Set(),
      isWorking: false,
      lifecycleWorking: false
    })
    expect(slots.find((slot) => slot.kind === 'message')).toMatchObject({
      message: { id: message.id },
      drawsMessage: true
    })

    render(
      <TooltipProvider>
        <MessageRow message={message} expandSignal={false} onScrollMessageToTop={() => {}} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: /Morning digest/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open automation' }))
    expect(openBotAutomation).toHaveBeenCalledWith('auto-1', null)
  })
})
