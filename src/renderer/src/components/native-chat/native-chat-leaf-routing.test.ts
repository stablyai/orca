import { describe, expect, it } from 'vitest'
import { resolveNativeChatLeafRoute } from './native-chat-leaf-routing'

describe('resolveNativeChatLeafRoute', () => {
  it('keeps chat attached to its eligible leaf when focus moves to a shell sibling', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'agent-leaf',
        activeLeafId: 'shell-leaf',
        chatLeafStillMounted: true,
        activeLeafIsEligible: false
      })
    ).toEqual({ chatLeafId: 'agent-leaf', exitChat: false })
  })

  it('exits chat when the user closes its pane', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'closed-leaf',
        activeLeafId: 'agent-sibling',
        chatLeafStillMounted: false,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: null, exitChat: true })
  })

  it('exits chat when the mounted agent has authoritatively returned to its shell', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'exited-agent',
        activeLeafId: 'exited-agent',
        chatLeafStillMounted: true,
        activeLeafIsEligible: true,
        chatLeafHasConfirmedAgentExit: true
      })
    ).toEqual({ chatLeafId: null, exitChat: true })
  })

  it('moves chat to an eligible sibling after the owning agent exits', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'exited-agent',
        activeLeafId: 'agent-sibling',
        chatLeafStillMounted: true,
        activeLeafIsEligible: true,
        chatLeafHasConfirmedAgentExit: true
      })
    ).toEqual({ chatLeafId: 'agent-sibling', exitChat: false })
  })

  it('attaches a tab-level chat request to the eligible active leaf', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: null,
        activeLeafId: 'active-agent',
        chatLeafStillMounted: false,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: 'active-agent', exitChat: false })
  })

  it('waits through manager hydration when there is no concrete active leaf', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'restored-agent',
        activeLeafId: null,
        chatLeafStillMounted: false,
        activeLeafIsEligible: false
      })
    ).toEqual({ chatLeafId: 'restored-agent', exitChat: false })
  })
})
