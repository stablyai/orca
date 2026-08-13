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
      {
        actorKind: 'agent',
        identity: 'codex',
        displayName: 'Claude Impersonator',
        state: 'online',
        participation: 'active'
      },
      {
        actorKind: 'agent',
        identity: 'claude',
        displayName: 'Researcher',
        state: 'busy',
        participation: 'active'
      },
      {
        actorKind: 'agent',
        identity: 'gemini',
        displayName: 'Gemini',
        state: 'online',
        participation: 'paused'
      },
      { actorKind: 'user', identity: 'user', displayName: 'You', state: 'online' }
    ] as RoomParticipant[]

    expect(getRoomComposerSuggestions(getRoomComposerQuery('@cl', 3), participants)).toEqual([
      expect.objectContaining({
        value: '@claude',
        identity: 'claude',
        displayName: 'Researcher'
      })
    ])
    expect(getRoomComposerSuggestions(getRoomComposerQuery('@imp', 4), participants)).toEqual([])
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
