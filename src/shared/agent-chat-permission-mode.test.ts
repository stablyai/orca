import { describe, expect, it } from 'vitest'
import {
  AGENT_CHAT_PERMISSION_MODES,
  agentChatPermissionModes,
  newChatPermissionMode,
  savedChatPermissionMode
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
  it('asks for a chat saved before modes existed, or with a value its agent cannot run', () => {
    expect(savedChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, undefined)).toBe('ask')
    expect(savedChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, null)).toBe('ask')
    expect(savedChatPermissionMode(CODEX_CHAT_PERMISSION_MODES, 'accept-edits')).toBe('ask')
    expect(savedChatPermissionMode(CLAUDE_CHAT_PERMISSION_MODES, 'bypassPermissions')).toBe('ask')
  })
})
