import { describe, expect, it } from 'vitest'
import type { BrowserSessionProfile } from '../../../../shared/types'
import { buildWebAiAccountFromDraft } from './web-ai-account-draft'

const profile: BrowserSessionProfile = {
  id: 'profile-doubao',
  scope: 'isolated',
  partition: 'persist:profile-doubao',
  label: 'Doubao browser',
  source: null
}

describe('buildWebAiAccountFromDraft', () => {
  it('persists normalized Custom provider metadata', () => {
    expect(
      buildWebAiAccountFromDraft({
        draft: {
          provider: 'custom',
          label: 'Personal Doubao',
          profileId: null,
          customServiceLabel: 'Doubao',
          customHomeUrl: 'https://www.doubao.com/chat/',
          customCookieDomains: ['doubao.com']
        },
        profile,
        id: 'account-doubao',
        createdAt: 123
      })
    ).toEqual({
      id: 'account-doubao',
      provider: 'custom',
      label: 'Personal Doubao',
      executionHostId: 'local',
      profileId: profile.id,
      sessionPartition: profile.partition,
      customServiceLabel: 'Doubao',
      customHomeUrl: 'https://www.doubao.com/chat/',
      customCookieDomains: ['doubao.com'],
      createdAt: 123
    })
  })
})
