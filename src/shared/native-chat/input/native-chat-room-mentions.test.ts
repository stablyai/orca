import { describe, expect, it } from 'vitest'
import { rankNativeChatRoomMembers, rankNativeChatRoomMentions } from './native-chat-room-mentions'

describe('room mention ranking', () => {
  it('lists prefix matches before substring matches, case-insensitively', () => {
    expect(rankNativeChatRoomMentions(['Code Scout', 'Scout', 'Sage', 'everyone'], 'sc')).toEqual([
      'Scout',
      'Code Scout'
    ])
    expect(rankNativeChatRoomMentions(['Scout', 'everyone'], '')).toEqual(['Scout', 'everyone'])
  })
})

describe('rankNativeChatRoomMembers', () => {
  it('matches what a bot is for after its name', () => {
    const members = [
      { name: 'Docs', detail: 'keeping the docs site current' },
      { name: 'Triage', detail: 'sorting new bugs into docs or code' }
    ]
    expect(rankNativeChatRoomMembers(members, 'doc')).toEqual(['Docs', 'Triage'])
    expect(rankNativeChatRoomMembers(members, 'bugs')).toEqual(['Triage'])
  })
})

it('matches a name across its spaces and punctuation', () => {
  const names = ['Eng - Perf', 'Eng - Reviewer', 'Eng - Reviewer - Official']
  expect(rankNativeChatRoomMentions(names, 'eng-rev')).toEqual([
    'Eng - Reviewer',
    'Eng - Reviewer - Official'
  ])
  expect(
    rankNativeChatRoomMembers([{ name: 'Eng - Reviewer - Official' }], 'reviewer-off')
  ).toEqual(['Eng - Reviewer - Official'])
})
