import { describe, expect, it } from 'vitest'
import { aiVaultSearchHitHostLabels } from './ai-vault-search-hit-hosts'

describe('aiVaultSearchHitHostLabels', () => {
  it('returns null while every hit came from one host', () => {
    expect(
      aiVaultSearchHitHostLabels(
        [{ executionHostId: 'runtime:devbox' }, { executionHostId: 'runtime:devbox' }],
        [{ id: 'runtime:devbox', label: 'devbox' }]
      )
    ).toBeNull()
  })

  it('names each host the way the host menu does, with the id label as fallback', () => {
    const labels = aiVaultSearchHitHostLabels(
      [
        { executionHostId: 'local' },
        { executionHostId: 'runtime:env-1' },
        { executionHostId: 'runtime:env-gone' }
      ],
      [
        { id: 'local', label: 'Local Mac' },
        { id: 'runtime:env-1', label: 'devbox' }
      ]
    )

    expect(labels && Object.fromEntries(labels)).toEqual({
      local: 'Local Mac',
      'runtime:env-1': 'devbox',
      'runtime:env-gone': 'env-gone'
    })
  })
})
