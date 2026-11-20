import { describe, expect, it } from 'vitest'
import { unlistedModelLabel } from './model-id-label'

describe('unlistedModelLabel', () => {
  it('names an unlisted chat model like the listed rows only for Claude, keeping its date', () => {
    expect([
      unlistedModelLabel('claude', 'claude-opus-4-1'),
      unlistedModelLabel('opencode', 'claude-opus-4-1'),
      unlistedModelLabel('claude', 'claude-opus-5-5-20251101')
    ]).toEqual(['Opus 4.1', 'Claude Opus 4.1', 'Opus 5.5 20251101'])
  })
})
