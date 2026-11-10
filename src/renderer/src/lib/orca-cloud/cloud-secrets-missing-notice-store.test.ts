import { afterEach, describe, expect, it } from 'vitest'
import {
  clearCloudSecretsMissing,
  narrowCloudSecretsMissing,
  readCloudSecretsMissing,
  recordCloudSecretsMissing,
  resetCloudSecretsMissingForTests
} from './cloud-secrets-missing-notice-store'

const REPO = 'github.com/acme/web'

describe('cloud secrets missing notice', () => {
  afterEach(() => resetCloudSecretsMissingForTests())

  it('keeps names per workspace until filled or dismissed', () => {
    recordCloudSecretsMissing('ws', { names: ['A', 'B'], repoKey: REPO }, 1)
    narrowCloudSecretsMissing('ws', ['B', 'C'])
    expect(readCloudSecretsMissing('ws')?.names).toEqual(['B'])
    narrowCloudSecretsMissing('ws', [])
    expect(readCloudSecretsMissing('ws')).toBeNull()
    recordCloudSecretsMissing('ws', { names: ['A'], repoKey: REPO })
    clearCloudSecretsMissing('ws')
    expect(readCloudSecretsMissing('ws')).toBeNull()
  })

  it('records nothing when nothing is missing', () => {
    recordCloudSecretsMissing('ws', { names: [], repoKey: REPO })
    expect(readCloudSecretsMissing('ws')).toBeNull()
  })
})
