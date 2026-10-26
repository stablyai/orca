import { describe, expect, it } from 'vitest'
import {
  AGENT_CHAT_PERMISSION_MODES,
  agentChatPermissionModes,
  chatModelSupportsAutoMode,
  chatPermissionModeNeedsModelSupport,
  effectiveChatPermissionMode,
  newChatPermissionMode,
  offeredChatPermissionModes
} from './agent-chat-permission-mode'

const CLAUDE_CHAT_PERMISSION_MODES = agentChatPermissionModes('claude')!
const CODEX_CHAT_PERMISSION_MODES = agentChatPermissionModes('codex')!

describe('agent chat permission modes', () => {
  it('orders the picker from least to most access', () => {
    expect(AGENT_CHAT_PERMISSION_MODES).toEqual(['ask', 'accept-edits', 'auto', 'full-access'])
  })

  it('offers Claude every mode, Codex no edits-only mode, ACP agents Ask and Full access', () => {
    expect(agentChatPermissionModes('claude')?.modes).toEqual(AGENT_CHAT_PERMISSION_MODES)
    expect(agentChatPermissionModes('codex')?.modes).toEqual(['ask', 'auto', 'full-access'])
    expect(agentChatPermissionModes('omp')?.modes).toEqual(['ask', 'full-access'])
    expect(agentChatPermissionModes('pi')).toBeNull()
  })

  it('seeds a new chat from the host setting, narrowed to what its agent offers', () => {
    expect(newChatPermissionMode('codex', 'accept-edits')).toBe('ask')
    expect(newChatPermissionMode('claude', 'accept-edits')).toBe('accept-edits')
    // Claude's auto is narrowed at launch by the model, so the chat keeps its choice.
    expect(newChatPermissionMode('claude', 'auto')).toBe('auto')
    expect(newChatPermissionMode('codex', 'full-access')).toBe('full-access')
    expect(newChatPermissionMode('claude', 'retired-mode')).toBe('ask')
    expect(newChatPermissionMode('claude', undefined)).toBe('ask')
    expect(newChatPermissionMode('omp', 'full-access')).toBe('full-access')
    expect(newChatPermissionMode('omp', 'accept-edits')).toBe('ask')
    expect(newChatPermissionMode('pi', 'full-access')).toBeNull()
  })
})

describe('the mode a chat runs', () => {
  it('runs Claude auto only on a model listed as supporting it', () => {
    expect(effectiveChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, 'auto', true)).toBe('auto')
    expect(effectiveChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, 'auto', false)).toBe('ask')
    expect(chatPermissionModeNeedsModelSupport(CLAUDE_CHAT_PERMISSION_MODES, 'auto')).toBe(true)
    expect(chatPermissionModeNeedsModelSupport(CLAUDE_CHAT_PERMISSION_MODES, 'ask')).toBe(false)
  })

  it('runs Codex auto on any model', () => {
    expect(effectiveChatPermissionMode(CODEX_CHAT_PERMISSION_MODES, 'auto', false)).toBe('auto')
    expect(chatPermissionModeNeedsModelSupport(CODEX_CHAT_PERMISSION_MODES, 'auto')).toBe(false)
  })

  it('asks for a chat saved before modes existed, or with a value its agent cannot run', () => {
    expect(effectiveChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, undefined, true)).toBe('ask')
    expect(effectiveChatPermissionMode(CODEX_CHAT_PERMISSION_MODES, 'accept-edits', true)).toBe(
      'ask'
    )
    expect(
      effectiveChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, 'bypassPermissions', true)
    ).toBe('ask')
  })

  it('offers Approve for me only where the model runs it', () => {
    expect(offeredChatPermissionModes(CLAUDE_CHAT_PERMISSION_MODES, false)).toEqual([
      'ask',
      'accept-edits',
      'full-access'
    ])
    expect(offeredChatPermissionModes(CLAUDE_CHAT_PERMISSION_MODES, true)).toEqual(
      AGENT_CHAT_PERMISSION_MODES
    )
    expect(offeredChatPermissionModes(CODEX_CHAT_PERMISSION_MODES, false)).toEqual([
      'ask',
      'auto',
      'full-access'
    ])
  })
})

describe('the model permission catalog', () => {
  // The catalog shape `claude` 2.1.280 lists: the default row is folded into the row it resolves to.
  it('reads auto support from the chat model row, or the CLI default when it names none', () => {
    const models = [
      { id: 'opus[1m]', isDefault: true, supportsAutoMode: true },
      { id: 'sonnet', isDefault: false, supportsAutoMode: true },
      { id: 'haiku', isDefault: false }
    ]
    for (const model of [undefined, null, 'default', 'opus[1m]', 'sonnet']) {
      expect(chatModelSupportsAutoMode(models, model)).toBe(true)
    }
    for (const model of ['haiku', 'claude-opus-5-5[1m]', 'retired-model']) {
      expect(chatModelSupportsAutoMode(models, model)).toBe(false)
    }
    // No row the CLI runs by default: unknown, so no auto.
    expect(chatModelSupportsAutoMode([{ id: 'opus[1m]', supportsAutoMode: true }], undefined)).toBe(
      false
    )
  })
})
