import { describe, expect, it } from 'vitest'
import { distinguishSharedModelLabels } from './native-chat-model-choice-labels'

describe('distinguishSharedModelLabels', () => {
  it('leaves unique model names unchanged', () => {
    expect(
      distinguishSharedModelLabels([
        { id: 'fable', label: 'Fable' },
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' }
      ])
    ).toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku'])
  })

  it('names the provider when two routes share a base name', () => {
    expect(
      distinguishSharedModelLabels([
        { id: 'provider-a/claude-sonnet-5-5', label: 'Sonnet 5.5' },
        { id: 'provider-b/claude-sonnet-5-5', label: 'Sonnet 5.5' }
      ])
    ).toEqual(['Sonnet 5.5 (provider-a)', 'Sonnet 5.5 (provider-b)'])
  })

  it('uses the full model id when one provider lists two models under one name', () => {
    expect(
      distinguishSharedModelLabels([
        { id: 'provider-a/claude-sonnet-5-5', label: 'Sonnet' },
        { id: 'provider-a/claude-sonnet-5-5-fast', label: 'Sonnet' }
      ])
    ).toEqual([
      'Sonnet (provider-a/claude-sonnet-5-5)',
      'Sonnet (provider-a/claude-sonnet-5-5-fast)'
    ])
  })

  it('separates a provider route from a base id that is only a substring of the shared label', () => {
    expect(
      distinguishSharedModelLabels([
        { id: 'provider-a/sonnet', label: 'provider-a/sonnet' },
        { id: 'sonnet', label: 'provider-a/sonnet' }
      ])
    ).toEqual(['provider-a/sonnet (provider-a)', 'provider-a/sonnet (sonnet)'])
  })

  it('keeps a full-id label distinct from another choice that already used that text', () => {
    expect(
      distinguishSharedModelLabels([
        { id: 'acme/one', label: 'Model' },
        { id: 'acme/two', label: 'Model' },
        { id: 'other', label: 'Model (acme/one)' }
      ])
    ).toEqual(['Model (acme/one) #1', 'Model (acme/two)', 'Model (acme/one) (other)'])
  })
})
