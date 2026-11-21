import { describe, expect, it } from 'vitest'
import {
  conversationPreferenceKey,
  normalizeConversationPreferences,
  updateConversationPreference
} from './conversation-navigation-preferences'

describe('conversation navigation preferences', () => {
  it('keeps host identities and provider transcripts separate while native handles share one identity', () => {
    const row = {
      executionHostId: 'local' as const,
      agent: 'claude' as const,
      sessionId: 'provider-old',
      structuredSession: { sessionId: 'chat', workspaceId: 'folder:notes' }
    }
    expect(conversationPreferenceKey(row)).toBe(
      conversationPreferenceKey({ ...row, sessionId: 'provider-new' })
    )
    expect(conversationPreferenceKey(row)).not.toBe(
      conversationPreferenceKey({ ...row, executionHostId: 'runtime:remote' })
    )
    expect(conversationPreferenceKey(row)).not.toBe(
      conversationPreferenceKey({ ...row, structuredSession: undefined })
    )
  })
  it('merges independent pin/archive writes and restores an archived pinned conversation', () => {
    const pin = updateConversationPreference(null, { key: 'a', pinned: true })
    const archive = updateConversationPreference(pin, { key: 'a', archived: true })
    const other = updateConversationPreference(archive, { key: 'b', pinned: true })
    const restored = updateConversationPreference(other, { key: 'a', archived: false })
    expect(restored).toEqual({
      revision: 4,
      entries: { a: { pinned: true, archived: false }, b: { pinned: true } }
    })
  })
  it('tolerates absent and malformed older persisted state', () => {
    expect(normalizeConversationPreferences(null)).toEqual({ revision: 0, entries: {} })
    expect(normalizeConversationPreferences({ revision: 3, entries: { a: 'bad' } })).toEqual({
      revision: 3,
      entries: { a: {} }
    })
  })
  it('hides and restores one host-qualified project without changing chat preferences', () => {
    const pinned = updateConversationPreference(null, { key: 'chat', pinned: true })
    const local = JSON.stringify(['local', 'folder:/notes'])
    const remote = JSON.stringify(['runtime:server', 'folder:/notes'])
    const hidden = updateConversationPreference(pinned, {
      projectKey: local,
      label: 'Notes',
      hidden: true
    })
    const both = updateConversationPreference(hidden, {
      projectKey: remote,
      label: 'Remote notes',
      hidden: true
    })
    const restored = updateConversationPreference(both, {
      projectKey: local,
      label: 'Notes',
      hidden: false
    })
    expect(restored).toEqual({
      revision: 4,
      entries: { chat: { pinned: true } },
      hiddenProjects: { [remote]: 'Remote notes' }
    })
  })
  it('separates provider histories by distro and Antigravity origin while keeping stored chat handles stable', () => {
    const row = {
      executionHostId: 'local' as const,
      agent: 'codex',
      sessionId: 'same',
      filePath: '/home/me/.codex/a.jsonl'
    }
    const ubuntu = { ...row, filePath: '//wsl.localhost/Ubuntu/home/me/.codex/a.jsonl' }
    const debian = { ...row, filePath: '//wsl.localhost/Debian/home/me/.codex/a.jsonl' }
    expect(new Set([row, ubuntu, debian].map(conversationPreferenceKey)).size).toBe(3)
    const cli = {
      ...row,
      agent: 'antigravity',
      filePath: '/home/me/.gemini/antigravity-cli/brain/same/transcript.jsonl'
    }
    const ide = { ...cli, filePath: cli.filePath.replace('antigravity-cli', 'antigravity-ide') }
    expect(conversationPreferenceKey(cli)).not.toBe(conversationPreferenceKey(ide))
  })
})
