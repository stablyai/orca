import { describe, expect, it } from 'vitest'
import { updateMapping } from './CodexMicroSettingsPane'

describe('CodexMicroSettingsPane mapping updates', () => {
  it('adds and explicitly removes mappings without mutating the prior snapshot', () => {
    const original = { AG00: 'worktree.navigateUp' } as const
    const added = updateMapping(original, 'ACT06', 'worktree.history.back')
    const removed = updateMapping(added, 'AG00', undefined)

    expect(added).toEqual({ AG00: 'worktree.navigateUp', ACT06: 'worktree.history.back' })
    expect(removed).toEqual({ ACT06: 'worktree.history.back' })
    expect(original).toEqual({ AG00: 'worktree.navigateUp' })
  })
})
