import { describe, expect, it } from 'vitest'

import {
  AVATAR_TONE_COUNT,
  getAssigneeAvatarTone,
  NEUTRAL_AVATAR_TONE
} from './assignee-avatar-tone'

/** Shapes a provider actually sends: Azure Boards GUIDs, Jira account ids. */
const REALISTIC_IDS = [
  '0f9a1e3c-2b44-4a0d-9c6f-1f0b9c2d3e4a',
  '1a2b3c4d-5e6f-4708-9a0b-1c2d3e4f5061',
  '2c4e6a80-1357-49bd-8ace-02468ace1357',
  '3d5f7b91-2468-4ace-9bdf-13579bdf2468',
  '4e6a8c02-3579-4bdf-8ace-2468ace13579',
  '5f7b9d13-468a-4ce0-9df1-3579bdf2468a',
  '6a8c0e24-579b-4df1-8ac2-468ace13579b',
  '7b9d1f35-68ac-4e02-9df3-579bdf2468ac',
  '8c0e2a46-79bd-4f13-8ace-68ace13579bd',
  '9d1f3b57-8ace-4024-9bdf-79bdf2468ace',
  'ae2048c6-9bdf-4135-8ac2-8ace13579bdf',
  'bf3159d7-acde-4246-9bd3-9bdf2468ace1',
  '5b10a2844c20165700ede21g',
  '5b10ac8d82e05b22cc7d4ef5',
  '712020:9a1b2c3d-4e5f-4061-8273-849506a7b8c9',
  '712020:0f1e2d3c-4b5a-4968-8776-655443322110',
  'aad.MjM0NTY3ODkwMTIzNDU2Nzg5',
  'aad.OTg3NjU0MzIxMDk4NzY1NDMy',
  'vss.ZGV2LmF6dXJlLmNvbS9vcmcvdXNlcjE',
  'vss.ZGV2LmF6dXJlLmNvbS9vcmcvdXNlcjI',
  'user-1',
  'user-2',
  'user-3',
  'user-4',
  'user-5',
  'user-6',
  'user-7',
  'user-8',
  'davidm@example.com',
  'amelia.kato@example.com',
  'm.rahman@example.com',
  'sofia.ruiz@example.com'
]

describe('getAssigneeAvatarTone', () => {
  it('returns the same tone for the same id on every call', () => {
    const assignee = { id: 'u-42', displayName: 'David Mugisha' }
    const first = getAssigneeAvatarTone(assignee)

    expect(getAssigneeAvatarTone(assignee)).toBe(first)
    expect(getAssigneeAvatarTone({ id: 'u-42', displayName: 'David Mugisha' })).toBe(first)
  })

  it('gives an id the same tone wherever it sits in a list', () => {
    const others = REALISTIC_IDS.slice(0, 5).map((id) => ({ id, displayName: id }))
    const target = { id: 'u-42', displayName: 'David Mugisha' }

    const toneAtStart = [target, ...others].map((a) => getAssigneeAvatarTone(a))[0]
    const toneAtEnd = [...others, target].map((a) => getAssigneeAvatarTone(a)).at(-1)

    expect(toneAtEnd).toBe(toneAtStart)
  })

  it('keeps the tone when the display name changes but the id does not', () => {
    const before = getAssigneeAvatarTone({ id: 'u-42', displayName: 'David Mugisha' })
    const after = getAssigneeAvatarTone({ id: 'u-42', displayName: 'David M. Mugisha' })

    expect(after).toBe(before)
  })

  it('gives two people with the same display name different tones', () => {
    const one = getAssigneeAvatarTone({ id: 'u-1', displayName: 'Alex Kim' })
    const two = getAssigneeAvatarTone({ id: 'u-2', displayName: 'Alex Kim' })

    expect(one).not.toBe(two)
  })

  it('spreads a realistic set of ids across the whole palette', () => {
    const counts = new Map<string, number>()
    for (const id of REALISTIC_IDS) {
      const tone = getAssigneeAvatarTone({ id, displayName: 'Ignored Name' })
      counts.set(tone, (counts.get(tone) ?? 0) + 1)
    }

    expect(counts.size).toBe(AVATAR_TONE_COUNT)
    const largestShare = Math.max(...counts.values()) / REALISTIC_IDS.length
    expect(largestShare).toBeLessThan(0.3)
  })

  it('falls back to the display name when there is no id, and stays stable', () => {
    const first = getAssigneeAvatarTone({ id: null, displayName: 'Amelia Kato' })

    expect(first).not.toBe(NEUTRAL_AVATAR_TONE)
    expect(getAssigneeAvatarTone({ displayName: 'Amelia Kato' })).toBe(first)
    expect(getAssigneeAvatarTone({ id: '  ', displayName: 'Amelia Kato' })).toBe(first)
  })

  it('returns the neutral tone when there is nothing to identify', () => {
    expect(getAssigneeAvatarTone(null)).toBe(NEUTRAL_AVATAR_TONE)
    expect(getAssigneeAvatarTone(undefined)).toBe(NEUTRAL_AVATAR_TONE)
    expect(getAssigneeAvatarTone({ id: null, displayName: '   ' })).toBe(NEUTRAL_AVATAR_TONE)
  })
})
