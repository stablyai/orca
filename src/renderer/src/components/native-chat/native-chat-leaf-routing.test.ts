import { describe, expect, it } from 'vitest'
import {
  nativeChatLaunchAgentForLeaf,
  nativeChatLeafOwnsTabWideEvidence,
  resolveNativeChatLeafRoute
} from './native-chat-leaf-routing'

describe('nativeChatLeafOwnsTabWideEvidence', () => {
  it("owns tab-wide evidence only while the bound leaf is still the tab's sole pane", () => {
    expect(
      nativeChatLeafOwnsTabWideEvidence({
        ownerLeafId: 'leaf-a',
        leafId: 'leaf-a',
        leafIds: ['leaf-a']
      })
    ).toBe(true)
    // A split sibling must not inherit the tab's launch draft (issue #16695).
    expect(
      nativeChatLeafOwnsTabWideEvidence({
        ownerLeafId: 'leaf-a',
        leafId: 'leaf-b',
        leafIds: ['leaf-a', 'leaf-b']
      })
    ).toBe(false)
    // Not even the original pane keeps it once the tab is split.
    expect(
      nativeChatLeafOwnsTabWideEvidence({
        ownerLeafId: 'leaf-a',
        leafId: 'leaf-a',
        leafIds: ['leaf-a', 'leaf-b']
      })
    ).toBe(false)
    expect(
      nativeChatLeafOwnsTabWideEvidence({
        ownerLeafId: null,
        leafId: 'leaf-a',
        leafIds: ['leaf-a']
      })
    ).toBe(false)
  })
})

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
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: 'agent-leaf',
        activeLeafId: 'shell-leaf',
        chatLeafStillMounted: true,
        activeLeafDisposition: 'pending'
      })
    ).toEqual({ chatLeafId: 'agent-leaf', exitChat: false })
  })

  it('keeps chat attached through a transient eligibility loss and reconnect', () => {
    const disconnected = resolveNativeChatLeafRoute({
      savedOwnerDisposition: 'recover',
      isChatViewMode: true,
      chatLeafId: 'agent-leaf',
      activeLeafId: 'agent-leaf',
      chatLeafStillMounted: true,
      activeLeafDisposition: 'pending'
    })

    expect(disconnected).toEqual({ chatLeafId: 'agent-leaf', exitChat: false })
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: disconnected.chatLeafId,
        activeLeafId: 'agent-leaf',
        chatLeafStillMounted: true,
        activeLeafDisposition: 'recover'
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

  it('does not move chat when its mounted leaf temporarily becomes ineligible', () => {
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: true,
        chatLeafId: 'stopped-agent',
        activeLeafId: 'agent-sibling',
        chatLeafStillMounted: true,
        activeLeafDisposition: 'recover'
      })
    ).toEqual({ chatLeafId: 'stopped-agent', exitChat: false })
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

  it('clears leaf ownership after returning to terminal view', () => {
    expect(
      resolveNativeChatLeafRoute({
        savedOwnerDisposition: 'recover',
        isChatViewMode: false,
        chatLeafId: 'agent-leaf',
        activeLeafId: 'agent-leaf',
        chatLeafStillMounted: true,
        activeLeafDisposition: 'recover'
      })
    ).toEqual({ chatLeafId: null, exitChat: false })
  })
})
