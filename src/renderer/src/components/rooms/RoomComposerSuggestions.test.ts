import { describe, expect, it } from 'vitest'
import type { RoomParticipant } from '../../../../shared/rooms'
import {
  applyRoomComposerSuggestion,
  getExactRoomMentionSuggestion,
  getRoomComposerQuery,
  getRoomComposerSuggestions,
  resolveSelectedRoomRecipients
} from './RoomComposerSuggestions'

describe('room composer suggestions', () => {
  it('finds and inserts mentions and slash commands at the cursor', () => {
    const mention = getRoomComposerQuery('Ask @co later', 7)
    expect(mention).toMatchObject({ kind: 'mention', query: 'co', start: 4, end: 7 })
    expect(applyRoomComposerSuggestion('Ask @co later', mention!, '@codex')).toEqual({
      text: 'Ask @codex later',
      cursor: 10
    })

    const command = getRoomComposerQuery('/con', 4)
    expect(getRoomComposerSuggestions(command, [])).toEqual([
      { value: '/continue', label: '/continue · resume a paused agent loop' }
    ])
  })

  it('offers all and matching live room identities', () => {
    const participants = [
      { actorKind: 'agent', identity: 'codex', state: 'online', participation: 'active' },
      { actorKind: 'agent', identity: 'claude', state: 'busy', participation: 'active' },
      { actorKind: 'agent', identity: 'gemini', state: 'online', participation: 'paused' },
      { actorKind: 'user', identity: 'user', state: 'online' }
    ] as RoomParticipant[]

    expect(getRoomComposerSuggestions(getRoomComposerQuery('@cl', 3), participants)).toEqual([
      { value: '@claude', label: '@claude · busy' }
    ])
    const exactQuery = getRoomComposerQuery('@all', 4)
    const exactSuggestions = getRoomComposerSuggestions(exactQuery, participants)
    expect(getExactRoomMentionSuggestion(exactQuery, exactSuggestions)?.value).toBe('@all')
    expect(
      getExactRoomMentionSuggestion(
        getRoomComposerQuery('@al', 3),
        getRoomComposerSuggestions(getRoomComposerQuery('@al', 3), participants)
      )
    ).toBeNull()
    expect(resolveSelectedRoomRecipients(['@all'], participants)).toEqual(['codex', 'claude'])
    expect(resolveSelectedRoomRecipients(['@codex'], participants)).toEqual(['codex'])
    expect(resolveSelectedRoomRecipients(['@gemini'], participants)).toEqual([])
    expect(resolveSelectedRoomRecipients([], participants)).toEqual([])
  })
})
