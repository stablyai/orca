import { describe, expect, it } from 'vitest'
import {
  buildFileEditorCenteredLayoutContentClassName,
  buildFileEditorCenteredLayoutShellClassName,
  canToggleFileEditorCenteredLayout,
  isFileEditorCenteredLayoutEnabled
} from './file-editor-centered-layout'

describe('file-editor centered layout', () => {
  it('stays off for profiles that never set the preference', () => {
    expect(isFileEditorCenteredLayoutEnabled(undefined)).toBe(false)
    expect(isFileEditorCenteredLayoutEnabled(false)).toBe(false)
  })

  it('turns on only for an explicit true preference', () => {
    expect(isFileEditorCenteredLayoutEnabled(true)).toBe(true)
  })

  it('centers a max-w-4xl column when enabled', () => {
    expect(buildFileEditorCenteredLayoutShellClassName(true)).toContain('justify-center')
    expect(buildFileEditorCenteredLayoutContentClassName(true)).toContain('max-w-4xl')
  })

  it('keeps a full-width column when disabled', () => {
    expect(buildFileEditorCenteredLayoutShellClassName(undefined)).not.toContain('justify-center')
    expect(buildFileEditorCenteredLayoutContentClassName(false)).not.toContain('max-w-4xl')
  })

  it('matches the overflow menu: on for non-diff tabs, off for diffs and changes mode', () => {
    expect(canToggleFileEditorCenteredLayout({ mode: 'edit', isChangesMode: false })).toBe(true)
    expect(
      canToggleFileEditorCenteredLayout({ mode: 'markdown-preview', isChangesMode: false })
    ).toBe(true)
    expect(canToggleFileEditorCenteredLayout({ mode: 'diff', isChangesMode: false })).toBe(false)
    expect(canToggleFileEditorCenteredLayout({ mode: 'edit', isChangesMode: true })).toBe(false)
  })
})
