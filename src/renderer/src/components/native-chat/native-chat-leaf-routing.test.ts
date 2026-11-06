import { describe, expect, it } from 'vitest'
import { resolveNativeChatLeafRoute } from './native-chat-leaf-routing'

describe('resolveNativeChatLeafRoute', () => {
  it('keeps chat attached to its eligible leaf when focus moves to a shell sibling', () => {
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: 'agent-leaf',
        activeLeafId: 'shell-leaf',
        chatLeafStillMounted: true,
        activeLeafDisposition: 'pending'
      })
    ).toEqual({ chatLeafId: 'agent-leaf', exitChat: false })
  })

  it('exits chat when the user closes its pane', () => {
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: 'closed-leaf',
        activeLeafId: 'agent-sibling',
        chatLeafStillMounted: false,
        activeLeafDisposition: 'recover'
      })
    ).toEqual({ chatLeafId: null, exitChat: true })
  })

  it('exits chat when the mounted agent has authoritatively returned to its shell', () => {
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: 'exited-agent',
        activeLeafId: 'exited-agent',
        chatLeafStillMounted: true,
        activeLeafDisposition: 'recover',
        chatLeafHasConfirmedAgentExit: true
      })
    ).toEqual({ chatLeafId: null, exitChat: true })
  })

  it('moves chat to an eligible sibling after the owning agent exits', () => {
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: 'exited-agent',
        activeLeafId: 'agent-sibling',
        chatLeafStillMounted: true,
        activeLeafDisposition: 'recover',
        chatLeafHasConfirmedAgentExit: true
      })
    ).toEqual({ chatLeafId: 'agent-sibling', exitChat: false })
  })

  it('attaches a tab-level chat request to the eligible active leaf', () => {
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: null,
        activeLeafId: 'active-agent',
        chatLeafStillMounted: false,
        activeLeafDisposition: 'recover'
      })
    ).toEqual({ chatLeafId: 'active-agent', exitChat: false })
  })

  it('waits through manager hydration when there is no concrete active leaf', () => {
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: 'restored-agent',
        activeLeafId: null,
        chatLeafStillMounted: false,
        activeLeafDisposition: 'pending'
      })
    ).toEqual({ chatLeafId: 'restored-agent', exitChat: false })
  })
})
