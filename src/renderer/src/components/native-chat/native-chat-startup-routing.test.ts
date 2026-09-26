import { describe, expect, it } from 'vitest'
import { canToggleNativeChat } from './native-chat-availability'
import { resolveNativeChatLeafRoute } from './native-chat-leaf-routing'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'

describe('native chat startup routing', () => {
  it('preserves a Grok chat request until its local workspace owner hydrates', () => {
    const eligible = (connectionId: string | null | undefined): boolean =>
      canToggleNativeChat({
        experimentalNativeChatEnabled: true,
        contentType: 'terminal',
        launchAgent: 'grok',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
      })
    expect(eligible(undefined)).toBe(false)
    expect(eligible(null)).toBe(true)

    const pending = resolveNativeChatLeafRoute({
      isChatViewMode: true,
      chatLeafId: null,
      activeLeafId: 'grok-pane',
      chatLeafStillMounted: false,
      activeLeafIsEligible: eligible(undefined)
    })
    expect(pending).toEqual({ chatLeafId: null, exitChat: false })
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: !pending.exitChat,
        chatLeafId: pending.chatLeafId,
        activeLeafId: 'grok-pane',
        chatLeafStillMounted: false,
        activeLeafIsEligible: eligible(null)
      })
    ).toEqual({ chatLeafId: 'grok-pane', exitChat: false })
  })

  it('does not bind a pending request to an unsupported shell', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: null,
        activeLeafId: 'shell-pane',
        chatLeafStillMounted: false,
        activeLeafIsEligible: false
      })
    ).toEqual({ chatLeafId: null, exitChat: false })
  })

  it('honors a confirmed exit even before the initial chat leaf binds', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: null,
        activeLeafId: null,
        chatLeafStillMounted: false,
        activeLeafIsEligible: false,
        chatLeafHasConfirmedAgentExit: true
      })
    ).toEqual({ chatLeafId: null, exitChat: true })
  })
})
