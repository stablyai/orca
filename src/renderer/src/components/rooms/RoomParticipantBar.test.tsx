import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RoomParticipant } from '../../../../shared/rooms'
import { contextLabel, getRoomParticipantWheelScrollLeft } from './RoomParticipantBar'

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

describe('room participant horizontal wheel scrolling', () => {
  it('maps vertical wheel movement into the available horizontal range', () => {
    expect(
      getRoomParticipantWheelScrollLeft({
        clientWidth: 300,
        deltaX: 0,
        deltaY: 120,
        scrollLeft: 50,
        scrollWidth: 500
      })
    ).toBe(170)
    expect(
      getRoomParticipantWheelScrollLeft({
        clientWidth: 300,
        deltaX: 0,
        deltaY: 120,
        scrollLeft: 170,
        scrollWidth: 500
      })
    ).toBe(200)
  })

  it('leaves native horizontal gestures and non-overflowing strips alone', () => {
    expect(
      getRoomParticipantWheelScrollLeft({
        clientWidth: 300,
        deltaX: 80,
        deltaY: 20,
        scrollLeft: 0,
        scrollWidth: 500
      })
    ).toBeNull()
    expect(
      getRoomParticipantWheelScrollLeft({
        clientWidth: 300,
        deltaX: 0,
        deltaY: 40,
        scrollLeft: 0,
        scrollWidth: 300
      })
    ).toBeNull()
  })
})

describe('room responsive layout contract', () => {
  it('isolates pill overflow and preserves spacing between room choices', () => {
    const participantBarSource = readFileSync(
      new URL('./RoomParticipantBar.tsx', import.meta.url),
      'utf8'
    )
    const selectorSource = readFileSync(
      new URL('./RoomSelectorDialog.tsx', import.meta.url),
      'utf8'
    )

    expect(participantBarSource).toContain('grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto]')
    expect(participantBarSource).toContain(
      "'terminal-tab-strip flex min-w-0 flex-1 gap-2 overflow-x-auto overflow-y-hidden'"
    )
    expect(participantBarSource).not.toMatch(/<header className="[^"]*overflow-hidden/)
    expect(selectorSource).toContain('[&_[cmdk-list-sizer]]:space-y-2')
  })
})
