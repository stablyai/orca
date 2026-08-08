import { describe, expect, it } from 'vitest'
import type { RoomParticipant } from '../../../../shared/rooms'
import { contextLabel } from './RoomParticipantBar'

function participant(context: Partial<RoomParticipant['context']> = {}): RoomParticipant {
  return {
    id: 'participant',
    roomId: 'room',
    identity: 'codex',
    displayName: 'Codex',
    actorKind: 'agent',
    agent: 'codex',
    roleId: null,
    worktreeId: 'worktree',
    paneKey: 'pane',
    terminalHandle: 'terminal',
    providerSession: null,
    processIncarnation: null,
    participation: 'active',
    state: 'online',
    context: {
      usedTokens: 123_000,
      maxTokens: 258_000,
      remainingTokens: 135_000,
      usedPercent: 47.7,
      source: 'provider',
      observedAt: 1,
      compaction: 'idle',
      compactionUpdatedAt: null,
      ...context
    },
    lastSeenAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('room participant context label', () => {
  it('shows used, maximum, free, approximate, and unavailable states', () => {
    expect(contextLabel(participant())).toBe('123.0k / 258.0k · 135.0k free')
    expect(contextLabel(participant({ estimated: true }))).toMatch(/^~123\.0k/)
    expect(contextLabel(participant({ maxTokens: null, remainingTokens: null }))).toBe(
      '123.0k used · limit unavailable'
    )
    expect(contextLabel(participant({ usedTokens: null }))).toBe('codex · context unavailable')
  })
})
