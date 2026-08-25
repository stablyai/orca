import { describe, expect, it } from 'vitest'
import {
  deriveNativeChatCanSend,
  isNativeChatAgentForegroundGone,
  shouldChatTakeOverMobileSurface
} from './native-chat-send-eligibility'

describe('deriveNativeChatCanSend', () => {
  it('blocks sends when a mobile client holds the pty (presence-lock active)', () => {
    expect(deriveNativeChatCanSend({ kind: 'mobile', clientId: 'phone-1' })).toBe(false)
  })

  it('allows sends when the desktop drives the pty', () => {
    expect(deriveNativeChatCanSend({ kind: 'desktop' })).toBe(true)
  })

  it('allows sends when the pty is idle', () => {
    expect(deriveNativeChatCanSend({ kind: 'idle' })).toBe(true)
  })

  it('treats an unresolved driver (null/undefined) as unlocked', () => {
    expect(deriveNativeChatCanSend(null)).toBe(true)
    expect(deriveNativeChatCanSend(undefined)).toBe(true)
  })
})

describe('isNativeChatAgentForegroundGone', () => {
  it('blocks a local pane once the foreground is proven back at the shell', () => {
    expect(isNativeChatAgentForegroundGone({ shellForeground: true, isRemote: false })).toBe(true)
  })

  it('allows a local pane while the agent still owns the foreground', () => {
    expect(isNativeChatAgentForegroundGone({ shellForeground: false, isRemote: false })).toBe(false)
  })

  it('never blocks a remote pane — shellForeground has no producer there (use-tab-agent.ts parity)', () => {
    expect(isNativeChatAgentForegroundGone({ shellForeground: true, isRemote: true })).toBe(false)
  })
})

describe('shouldChatTakeOverMobileSurface', () => {
  it('takes over the mobile surface when the tab is in chat view', () => {
    expect(shouldChatTakeOverMobileSurface('chat')).toBe(true)
  })

  it('leaves the terminal mobile overlay in place in terminal view', () => {
    expect(shouldChatTakeOverMobileSurface('terminal')).toBe(false)
  })
})
