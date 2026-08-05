import { describe, expect, it } from 'vitest'
import {
  isTerminalWorkbenchVisible,
  shouldShowWorktreeCreationSurface
} from './worktree-creation-surface'

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

describe('isTerminalWorkbenchVisible', () => {
  it('is visible for an open workspace with no creation flow in front of it', () => {
    expect(
      isTerminalWorkbenchVisible({
        activeView: 'terminal',
        activeWorktreeId: 'wt-1',
        activePendingCreationId: null,
        hasActivePendingCreation: false
      })
    ).toBe(true)
  })

  it('is hidden while creation covers the still-mounted previous workspace', () => {
    expect(
      isTerminalWorkbenchVisible({
        activeView: 'terminal',
        activeWorktreeId: 'wt-1',
        activePendingCreationId: 'creation-1',
        hasActivePendingCreation: true
      })
    ).toBe(false)
  })

  it('is hidden on another view and with no active workspace', () => {
    expect(
      isTerminalWorkbenchVisible({
        activeView: 'tasks',
        activeWorktreeId: 'wt-1',
        activePendingCreationId: null,
        hasActivePendingCreation: false
      })
    ).toBe(false)
    expect(
      isTerminalWorkbenchVisible({
        activeView: 'terminal',
        activeWorktreeId: null,
        activePendingCreationId: null,
        hasActivePendingCreation: false
      })
    ).toBe(false)
  })
})
