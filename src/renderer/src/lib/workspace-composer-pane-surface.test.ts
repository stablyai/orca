import { describe, expect, it } from 'vitest'
import { shouldShowWorkspaceComposerPane } from './workspace-composer-pane-surface'

describe('shouldShowWorkspaceComposerPane', () => {
  it('shows the pane when the prompt-first composer opens over the workspace view', () => {
    expect(
      shouldShowWorkspaceComposerPane({
        activeView: 'terminal',
        activeModal: 'new-workspace-composer',
        promptFirstComposer: true,
        creationSurfaceActive: false
      })
    ).toBe(true)
  })

  it('keeps the dialog when the experimental setting is off', () => {
    expect(
      shouldShowWorkspaceComposerPane({
        activeView: 'terminal',
        activeModal: 'new-workspace-composer',
        promptFirstComposer: false,
        creationSurfaceActive: false
      })
    ).toBe(false)
  })

  it('keeps the dialog on full-page views like settings', () => {
    expect(
      shouldShowWorkspaceComposerPane({
        activeView: 'settings',
        activeModal: 'new-workspace-composer',
        promptFirstComposer: true,
        creationSurfaceActive: false
      })
    ).toBe(false)
  })

  it('keeps the dialog while a worktree creation panel owns the center pane', () => {
    expect(
      shouldShowWorkspaceComposerPane({
        activeView: 'terminal',
        activeModal: 'new-workspace-composer',
        promptFirstComposer: true,
        creationSurfaceActive: true
      })
    ).toBe(false)
  })

  it('is inactive while another modal or none is open', () => {
    expect(
      shouldShowWorkspaceComposerPane({
        activeView: 'terminal',
        activeModal: 'none',
        promptFirstComposer: true,
        creationSurfaceActive: false
      })
    ).toBe(false)
  })
})
