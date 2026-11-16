import { describe, expect, it } from 'vitest'
import { CloudWorkspaceSchema } from './cloud-workspaces-wire'

const acting = CloudWorkspaceSchema.shape.githubActing
const you = CloudWorkspaceSchema.shape.you

describe('GIT-ACTOR wire fields', () => {
  it('parses member and bot, and tolerates older or newer control planes', () => {
    // `until` (the retired shared-workspace window) still parses and is dropped.
    expect(acting.parse({ actingAs: 'member', userId: 'u1', login: 'ada', until: 5 })).toEqual({
      actingAs: 'member',
      userId: 'u1',
      login: 'ada'
    })
    expect(acting.parse({ actingAs: 'bot', reason: 'window_expired' })).toEqual({
      actingAs: 'bot',
      reason: 'window_expired'
    })
    // A reason this desktop doesn't know reads as "off" (shows nothing); a broken value or none is undefined.
    expect(acting.parse({ actingAs: 'bot', reason: 'future_reason' })).toEqual({
      actingAs: 'bot',
      reason: 'off'
    })
    expect(acting.parse({ actingAs: 'someone' })).toBeUndefined()
    expect(acting.parse(undefined)).toBeUndefined()
    expect(you.parse({ connected: false })).toEqual({ connected: false })
    expect(you.parse('x')).toBeUndefined()
  })
})
