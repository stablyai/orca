import { describe, expect, it } from 'vitest'
import { agentChatPermissionModes } from './agent-chat-permission-support'
import { newChatPermissionMode, savedChatPermissionMode } from './agent-chat-permission-mode'

const CLAUDE_CHAT_PERMISSION_MODES = agentChatPermissionModes('claude')!
const CODEX_CHAT_PERMISSION_MODES = agentChatPermissionModes('codex')!

describe('agent chat permission modes', () => {
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
