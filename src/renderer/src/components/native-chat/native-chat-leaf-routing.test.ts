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
        chatLeafIsEligible: true,
        activeLeafIsEligible: false
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
        chatLeafIsEligible: false,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: 'agent-sibling', exitChat: false })
  })

  it('moves chat to an eligible active sibling when its mounted leaf becomes ineligible', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'stopped-agent',
        activeLeafId: 'agent-sibling',
        chatLeafStillMounted: true,
        chatLeafIsEligible: false,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: 'agent-sibling', exitChat: false })
  })

  it('exits chat rather than inheriting an active shell after close', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'closed-agent',
        activeLeafId: 'shell-leaf',
        chatLeafStillMounted: false,
        chatLeafIsEligible: false,
        activeLeafIsEligible: false
      })
    ).toEqual({ chatLeafId: null, exitChat: true })
  })

  it('exits chat when its leaf becomes ineligible and the active leaf is a shell', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: 'stopped-agent',
        activeLeafId: 'shell-leaf',
        chatLeafStillMounted: true,
        chatLeafIsEligible: false,
        activeLeafIsEligible: false
      })
    ).toEqual({ chatLeafId: null, exitChat: true })
  })

  it('attaches a tab-level chat request to the eligible active leaf', () => {
    expect(
      resolveNativeChatLeafRoute({
        isChatViewMode: true,
        chatLeafId: null,
        activeLeafId: 'active-agent',
        chatLeafStillMounted: false,
        chatLeafIsEligible: false,
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
        chatLeafIsEligible: false,
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
        chatLeafIsEligible: true,
        activeLeafIsEligible: true
      })
    ).toEqual({ chatLeafId: null, exitChat: false })
  })
})
