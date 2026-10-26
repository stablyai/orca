import { describe, expect, it } from 'vitest'
import {
  roomMentionSpans,
  roomMentionsIn,
  roomMemberNameProblem,
  ROOM_ALL_WORDS
} from './orchestration-room-mentions'

const member = (id: string, name: string) => ({ id, name })

describe('roomMentionSpans', () => {
  it('finds a bare @Name', () => {
    const spans = roomMentionSpans('@alice do this', [member('a1', 'alice')])
    expect(spans).toEqual([{ start: 0, end: 6, member: { id: 'a1', name: 'alice' } }])
  })

  it('matches longest member name first', () => {
    const members = [member('1', 'New'), member('2', 'New Bot 2')]
    const spans = roomMentionSpans('ask @New Bot 2', members)
    expect(spans).toEqual([{ start: 4, end: 14, member: { id: '2', name: 'New Bot 2' } }])
  })

  it('is case-insensitive', () => {
    const spans = roomMentionSpans('ping @ALICE', [member('a1', 'alice')])
    expect(spans).toHaveLength(1)
    expect(spans[0].member?.id).toBe('a1')
  })

  it('does not match when a letter follows the name', () => {
    // "@Mi" alone calls; "@MiniMax" does not (the name goes on).
    expect(roomMentionSpans('@Mi in @MiniMax', [member('m', 'Mi')])).toEqual([
      { start: 0, end: 3, member: { id: 'm', name: 'Mi' } }
    ])
  })

  it('skips email addresses', () => {
    expect(roomMentionSpans('mail a@b.com', [member('b', 'b')])).toEqual([])
  })

  it('skips file paths', () => {
    expect(roomMentionSpans('read @docs/guide.md', [member('d', 'docs')])).toEqual([])
  })

  it('skips code spans and fenced code', () => {
    const members = [member('a1', 'alice')]
    expect(roomMentionSpans('`@alice` and ```\n@alice\n```', members)).toEqual([])
    expect(roomMentionSpans('call `@alice` then @alice', members)).toEqual([
      { start: 19, end: 25, member: { id: 'a1', name: 'alice' } }
    ])
  })

  it('skips markdown links', () => {
    const members = [member('a1', 'alice')]
    expect(roomMentionSpans('see [@alice](http://x)', members)).toEqual([])
  })

  it('finds @all', () => {
    const spans = roomMentionSpans('@all please sync', [member('a', 'a')])
    expect(spans).toEqual([{ start: 0, end: 4, all: true }])
  })

  it('finds every @all alias', () => {
    for (const word of ROOM_ALL_WORDS) {
      const spans = roomMentionSpans(`@${word} go`, [])
      expect(spans, word).toEqual([{ start: 0, end: 1 + word.length, all: true }])
    }
  })

  it('treats a reference label as a citation, not a call', () => {
    const members = [member('a1', 'alice')]
    const spans = roomMentionSpans('@alice per @alice notes', members, {
      references: ['alice notes']
    })
    // first @alice calls; the second reads as the label "alice notes"
    expect(spans).toEqual([{ start: 0, end: 6, member: { id: 'a1', name: 'alice' } }])
  })
})

describe('roomMentionsIn', () => {
  it('returns the called members in order', () => {
    const members = [member('a', 'alpha'), member('b', 'beta'), member('g', 'gamma')]
    const { all, found } = roomMentionsIn('@beta and @alpha and @beta', members)
    expect(all).toBe(false)
    expect(found.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('excludes the speaker from its own calls', () => {
    const members = [member('a', 'alpha'), member('b', 'beta')]
    const { found } = roomMentionsIn('@alpha cc @beta', members, { speakerId: 'a' })
    expect(found.map((m) => m.id)).toEqual(['b'])
  })

  it('returns all=true on @all', () => {
    const { all, found } = roomMentionsIn('@all heads up', [
      member('a', 'alpha'),
      member('b', 'beta')
    ])
    expect(all).toBe(true)
    expect(found).toEqual([])
  })
})

describe('roomMemberNameProblem', () => {
  it('rejects blank, @, `, newline names', () => {
    expect(roomMemberNameProblem('')).toBeTruthy()
    expect(roomMemberNameProblem('has@at')).toBeTruthy()
    expect(roomMemberNameProblem('has`tick')).toBeTruthy()
    expect(roomMemberNameProblem('has\nline')).toBeTruthy()
  })

  it('rejects names that read as the user or everyone', () => {
    expect(roomMemberNameProblem('user')).toBeTruthy()
    expect(roomMemberNameProblem('You')).toBeTruthy()
    expect(roomMemberNameProblem('all')).toBeTruthy()
    expect(roomMemberNameProblem('Everyone')).toBeTruthy()
    expect(roomMemberNameProblem('所有人')).toBeTruthy()
  })

  it('accepts a normal name', () => {
    expect(roomMemberNameProblem('alice')).toBeUndefined()
    expect(roomMemberNameProblem('新 Bot 2')).toBeUndefined()
  })
})
