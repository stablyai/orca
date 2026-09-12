import { describe, expect, it } from 'vitest'
import {
  claudeSubmitGestureMatchesKeyboardEvent,
  CLAUDE_SUBMIT_ALT_ENTER,
  CLAUDE_SUBMIT_CTRL_J,
  CLAUDE_SUBMIT_ENTER,
  resolveClaudeSubmitBytes,
  resolveClaudeSubmitGesture,
  type ClaudeSubmitGesture
} from './native-chat-claude-submit-keybinding'

const withChatBindings = (bindings: Record<string, string>): string =>
  JSON.stringify({ bindings: [{ context: 'Chat', bindings }] })

describe('resolveClaudeSubmitBytes', () => {
  it('defaults to Enter with no config (Claude default: Enter submits)', () => {
    expect(resolveClaudeSubmitBytes(null)).toBe(CLAUDE_SUBMIT_ENTER)
    expect(resolveClaudeSubmitBytes(undefined)).toBe(CLAUDE_SUBMIT_ENTER)
    expect(resolveClaudeSubmitBytes('')).toBe(CLAUDE_SUBMIT_ENTER)
  })

  it('defaults to Enter when the config has no Chat submit binding', () => {
    expect(resolveClaudeSubmitBytes(withChatBindings({ 'ctrl+k': 'chat:clear' }))).toBe(
      CLAUDE_SUBMIT_ENTER
    )
  })

  it('uses Alt+Enter when Enter is remapped to newline and meta+enter submits', () => {
    // Syrine's config: Enter inserts a newline, submit moved to Cmd/Meta+Enter.
    const config = withChatBindings({
      enter: 'chat:newline',
      'cmd+enter': 'chat:submit',
      'meta+enter': 'chat:submit'
    })
    expect(resolveClaudeSubmitBytes(config)).toBe(CLAUDE_SUBMIT_ALT_ENTER)
  })

  it('keeps plain Enter when it is (still) the submit key', () => {
    expect(resolveClaudeSubmitBytes(withChatBindings({ enter: 'chat:submit' }))).toBe(
      CLAUDE_SUBMIT_ENTER
    )
  })

  it('prefers plain Enter over a modifier binding when both submit', () => {
    const config = withChatBindings({ enter: 'chat:submit', 'meta+enter': 'chat:submit' })
    expect(resolveClaudeSubmitBytes(config)).toBe(CLAUDE_SUBMIT_ENTER)
  })

  it('accepts alt/opt+enter aliases', () => {
    expect(resolveClaudeSubmitBytes(withChatBindings({ 'alt+enter': 'chat:submit' }))).toBe(
      CLAUDE_SUBMIT_ALT_ENTER
    )
    expect(resolveClaudeSubmitBytes(withChatBindings({ 'opt+enter': 'chat:submit' }))).toBe(
      CLAUDE_SUBMIT_ALT_ENTER
    )
  })

  it('maps a ctrl+j submit binding to a line feed', () => {
    expect(resolveClaudeSubmitBytes(withChatBindings({ 'ctrl+j': 'chat:submit' }))).toBe(
      CLAUDE_SUBMIT_CTRL_J
    )
  })

  it('falls back to Enter for a cmd-only submit (not pty-representable without kitty)', () => {
    expect(resolveClaudeSubmitBytes(withChatBindings({ 'cmd+enter': 'chat:submit' }))).toBe(
      CLAUDE_SUBMIT_ENTER
    )
  })

  it('ignores non-Chat contexts and malformed JSON', () => {
    const otherContext = JSON.stringify({
      bindings: [{ context: 'Confirmation', bindings: { 'meta+enter': 'chat:submit' } }]
    })
    expect(resolveClaudeSubmitBytes(otherContext)).toBe(CLAUDE_SUBMIT_ENTER)
    expect(resolveClaudeSubmitBytes('{ not json')).toBe(CLAUDE_SUBMIT_ENTER)
  })
})

describe('resolveClaudeSubmitGesture', () => {
  it('defaults to the enter gesture without a submit binding or when Enter submits', () => {
    expect(resolveClaudeSubmitGesture(null)).toBe('enter')
    expect(resolveClaudeSubmitGesture(withChatBindings({ enter: 'chat:submit' }))).toBe('enter')
  })

  it('resolves the alt-enter gesture when submit is remapped off Enter', () => {
    const config = withChatBindings({ enter: 'chat:newline', 'alt+enter': 'chat:submit' })
    expect(resolveClaudeSubmitGesture(config)).toBe('alt-enter')
  })

  it('resolves the ctrl-j gesture', () => {
    expect(resolveClaudeSubmitGesture(withChatBindings({ 'ctrl+j': 'chat:submit' }))).toBe('ctrl-j')
  })

  it('falls back to enter for a cmd-only submit', () => {
    expect(resolveClaudeSubmitGesture(withChatBindings({ 'cmd+enter': 'chat:submit' }))).toBe(
      'enter'
    )
  })
})

describe('claudeSubmitGestureMatchesKeyboardEvent', () => {
  const evt = (
    key: string,
    mods: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}
  ): { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean } => ({
    key,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false
  })
  const match = (gesture: ClaudeSubmitGesture, key: string, mods = {}): boolean =>
    claudeSubmitGestureMatchesKeyboardEvent(gesture, evt(key, mods))

  it('enter gesture: any Enter but Shift+Enter submits (unchanged default)', () => {
    expect(match('enter', 'Enter')).toBe(true)
    expect(match('enter', 'Enter', { shift: true })).toBe(false)
    expect(match('enter', 'Enter', { meta: true })).toBe(true)
    expect(match('enter', 'Enter', { alt: true })).toBe(true)
    expect(match('enter', 'a')).toBe(false)
  })

  it('alt-enter gesture: bare Enter is a newline, modifier+Enter submits', () => {
    expect(match('alt-enter', 'Enter')).toBe(false)
    expect(match('alt-enter', 'Enter', { alt: true })).toBe(true)
    expect(match('alt-enter', 'Enter', { meta: true })).toBe(true)
    expect(match('alt-enter', 'Enter', { shift: true })).toBe(false)
    expect(match('alt-enter', 'Enter', { ctrl: true })).toBe(false)
  })

  it('ctrl-j gesture: Ctrl+J submits, Enter is a newline', () => {
    expect(match('ctrl-j', 'j', { ctrl: true })).toBe(true)
    expect(match('ctrl-j', 'J', { ctrl: true })).toBe(true)
    expect(match('ctrl-j', 'Enter')).toBe(false)
    expect(match('ctrl-j', 'j')).toBe(false)
  })
})
