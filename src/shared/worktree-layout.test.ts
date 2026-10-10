import { describe, expect, it } from 'vitest'
import {
  buildWorktreeLayoutSettingsUpdate,
  isWorktreeLayout,
  nestWorkspacesForLayout,
  normalizeWorktreeLayoutUpdate,
  resolveWorktreeLayout
} from './worktree-layout'

describe('resolveWorktreeLayout', () => {
  it('derives nested and flat from the legacy boolean on profiles without a layout', () => {
    expect(resolveWorktreeLayout({ nestWorkspaces: true })).toBe('nested')
    expect(resolveWorktreeLayout({ nestWorkspaces: false })).toBe('flat')
  })

  it('prefers an explicit layout over the boolean', () => {
    expect(resolveWorktreeLayout({ worktreeLayout: 'sibling', nestWorkspaces: true })).toBe(
      'sibling'
    )
    expect(resolveWorktreeLayout({ worktreeLayout: 'flat', nestWorkspaces: true })).toBe('flat')
  })

  it('ignores unknown persisted values instead of trusting them', () => {
    const settings = JSON.parse('{"worktreeLayout":"beside","nestWorkspaces":false}')
    expect(isWorktreeLayout(settings.worktreeLayout)).toBe(false)
    expect(resolveWorktreeLayout(settings)).toBe('flat')
  })
})

describe('legacy nestWorkspaces mirror', () => {
  it('writes the boolean older builds read', () => {
    expect(nestWorkspacesForLayout('nested', false)).toBe(true)
    expect(nestWorkspacesForLayout('flat', true)).toBe(false)
    // Sibling keeps the last workspace-directory layout for builds that cannot express it.
    expect(nestWorkspacesForLayout('sibling', true)).toBe(true)
    expect(nestWorkspacesForLayout('sibling', false)).toBe(false)
  })

  it('builds a coherent settings patch', () => {
    expect(buildWorktreeLayoutSettingsUpdate('flat', { nestWorkspaces: true })).toEqual({
      worktreeLayout: 'flat',
      nestWorkspaces: false
    })
    expect(buildWorktreeLayoutSettingsUpdate('sibling', { nestWorkspaces: false })).toEqual({
      worktreeLayout: 'sibling',
      nestWorkspaces: false
    })
  })
})

describe('normalizeWorktreeLayoutUpdate', () => {
  it('ignores writes that touch neither key', () => {
    const updates: Record<string, unknown> = { workspaceDir: '/x' }
    expect(normalizeWorktreeLayoutUpdate({ nestWorkspaces: true }, updates)).toBe(null)
  })

  it('keeps the boolean coherent when a layout is written alone', () => {
    expect(
      normalizeWorktreeLayoutUpdate({ nestWorkspaces: true }, { worktreeLayout: 'flat' })
    ).toEqual({ worktreeLayout: 'flat', nestWorkspaces: false })
    expect(
      normalizeWorktreeLayoutUpdate(
        { worktreeLayout: 'flat', nestWorkspaces: false },
        { worktreeLayout: 'nested', nestWorkspaces: false }
      )
    ).toEqual({ worktreeLayout: 'nested', nestWorkspaces: true })
  })

  it('lets a legacy boolean writer move a stored layout instead of being overridden', () => {
    expect(
      normalizeWorktreeLayoutUpdate(
        { worktreeLayout: 'sibling', nestWorkspaces: true },
        { nestWorkspaces: false }
      )
    ).toEqual({ worktreeLayout: 'flat', nestWorkspaces: false })
  })

  it('leaves an unchanged boolean re-save alone', () => {
    expect(
      normalizeWorktreeLayoutUpdate(
        { worktreeLayout: 'sibling', nestWorkspaces: true },
        { nestWorkspaces: true }
      )
    ).toBe(null)
    // Legacy profiles keep deriving from the boolean; nothing new is persisted.
    expect(normalizeWorktreeLayoutUpdate({ nestWorkspaces: true }, { nestWorkspaces: false })).toBe(
      null
    )
  })

  it('clears an unknown layout so the boolean decides again', () => {
    expect(
      normalizeWorktreeLayoutUpdate(
        { worktreeLayout: 'sibling', nestWorkspaces: true },
        { worktreeLayout: 'beside' }
      )
    ).toEqual({ worktreeLayout: undefined })
  })
})
