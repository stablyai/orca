import { describe, expect, it } from 'vitest'
import {
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatLeafRoute
} from './native-chat-leaf-routing'

describe('nativeChatLaunchAgentForLeaf', () => {
  it('uses the tab launch hint only for its sole leaf', () => {
    expect(
      nativeChatLaunchAgentForLeaf({
        launchAgent: 'claude',
        launchAgentLeafId: 'leaf-a',
        leafId: 'leaf-a',
        leafIds: ['leaf-a']
      })
    ).toBe('claude')
    expect(
      nativeChatLaunchAgentForLeaf({
        launchAgent: 'claude',
        launchAgentLeafId: 'leaf-a',
        leafId: 'leaf-b',
        leafIds: ['leaf-a']
      })
    ).toBeNull()
    expect(
      nativeChatLaunchAgentForLeaf({
        launchAgent: 'claude',
        launchAgentLeafId: 'leaf-a',
        leafId: 'leaf-a',
        leafIds: []
      })
    ).toBeNull()
  })

  it('does not lend the original launch agent to either leaf of a mixed split', () => {
    const leafIds = ['agent-leaf', 'shell-leaf']

    expect(
      nativeChatLaunchAgentForLeaf({
        launchAgent: 'codex',
        launchAgentLeafId: 'agent-leaf',
        leafId: 'agent-leaf',
        leafIds
      })
    ).toBeNull()
    expect(
      nativeChatLaunchAgentForLeaf({
        launchAgent: 'codex',
        launchAgentLeafId: 'agent-leaf',
        leafId: 'shell-leaf',
        leafIds
      })
    ).toBeNull()
  })

  it('does not transfer the launch hint when the original leaf closes', () => {
    expect(
      nativeChatLaunchAgentForLeaf({
        launchAgent: 'codex',
        launchAgentLeafId: 'closed-agent-leaf',
        leafId: 'remaining-shell-leaf',
        leafIds: ['remaining-shell-leaf']
      })
    ).toBeNull()
  })
})

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

  it('keeps chat attached through a transient eligibility loss and reconnect', () => {
    const disconnected = resolveNativeChatLeafRoute({
      isChatViewMode: true,
      chatLeafId: 'agent-leaf',
      activeLeafId: 'agent-leaf',
      chatLeafStillMounted: true,
      activeLeafIsEligible: false
    })

    expect(disconnected).toEqual({ chatLeafId: 'agent-leaf', exitChat: false })
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: disconnected.chatLeafId,
        activeLeafId: 'agent-leaf',
        chatLeafStillMounted: true,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: 'agent-leaf', exitChat: false })
  })

  it('moves chat to an eligible active sibling after its leaf closes', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'closed-leaf',
        activeLeafId: 'agent-sibling',
        chatLeafStillMounted: false,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: 'agent-sibling', exitChat: false })
  })

  it('does not move chat when its mounted leaf temporarily becomes ineligible', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'stopped-agent',
        activeLeafId: 'agent-sibling',
        chatLeafStillMounted: true,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: 'stopped-agent', exitChat: false })
  })

  it('exits chat rather than inheriting an active shell after close', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'closed-agent',
        activeLeafId: 'shell-leaf',
        chatLeafStillMounted: false,
        activeLeafIsEligible: false
      })
    ).toEqual({ chatLeafId: null, exitChat: true })
  })

  it('keeps chat open when its mounted leaf loses agent evidence', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'stopped-agent',
        activeLeafId: 'shell-leaf',
        chatLeafStillMounted: true,
        activeLeafIsEligible: false
      })
    ).toEqual({ chatLeafId: 'stopped-agent', exitChat: false })
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

  it('clears leaf ownership after returning to terminal view', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: false,
        chatLeafId: 'agent-leaf',
        activeLeafId: 'agent-leaf',
        chatLeafStillMounted: true,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: null, exitChat: false })
  })
})
