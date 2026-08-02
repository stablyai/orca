import { describe, expect, it } from 'vitest'
import { shouldShowWorktreeCreationSurface } from './worktree-creation-surface'

describe('shouldShowWorktreeCreationSurface', () => {
  it('shows the creation surface as soon as an active pending creation exists', () => {
    expect(
      shouldShowWorktreeCreationSurface({
        activeView: 'terminal',
        activePendingCreationId: 'creation-1',
        hasActivePendingCreation: true
      })
    ).toBe(true)
  })

  it('stays hidden when the active pending id no longer has an entry', () => {
    expect(
      shouldShowWorktreeCreationSurface({
        activeView: 'terminal',
        activePendingCreationId: 'creation-1',
        hasActivePendingCreation: false
      })
    ).toBe(false)
  })

  it('stays hidden outside the terminal surface', () => {
    expect(
      shouldShowWorktreeCreationSurface({
        activeView: 'settings',
        activePendingCreationId: 'creation-1',
        hasActivePendingCreation: true
      })
    ).toBe(false)
  })
})
