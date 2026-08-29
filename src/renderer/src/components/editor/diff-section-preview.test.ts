import { describe, expect, it } from 'vitest'
import { canOpenDiffSectionPreviewToSide } from './diff-section-preview'

describe('canOpenDiffSectionPreviewToSide', () => {
  it('enables HTML working-tree sections that still exist on disk', () => {
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'docs/demo.html',
        status: 'modified',
        isCommitSurface: false,
        canOpenWorkspaceFileBrowser: true
      })
    ).toBe(true)
  })

  it('enables .htm paths', () => {
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'index.htm',
        status: 'added',
        isCommitSurface: false,
        canOpenWorkspaceFileBrowser: true
      })
    ).toBe(true)
  })

  it('enables untracked and renamed HTML files still present on disk', () => {
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'scratch.html',
        status: 'untracked',
        isCommitSurface: false,
        canOpenWorkspaceFileBrowser: true
      })
    ).toBe(true)
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'renamed.html',
        status: 'renamed',
        isCommitSurface: false,
        canOpenWorkspaceFileBrowser: true
      })
    ).toBe(true)
  })

  it('enables uppercase HTML extensions', () => {
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'Docs/DEMO.HTML',
        status: 'modified',
        isCommitSurface: false,
        canOpenWorkspaceFileBrowser: true
      })
    ).toBe(true)
  })

  it('disables deleted HTML files', () => {
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'gone.html',
        status: 'deleted',
        isCommitSurface: false,
        canOpenWorkspaceFileBrowser: true
      })
    ).toBe(false)
  })

  it('disables commit surfaces whose content may not match disk', () => {
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'docs/demo.html',
        status: 'modified',
        isCommitSurface: true,
        canOpenWorkspaceFileBrowser: true
      })
    ).toBe(false)
  })

  it('disables non-previewable languages', () => {
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'src/app.ts',
        status: 'modified',
        isCommitSurface: false,
        canOpenWorkspaceFileBrowser: true
      })
    ).toBe(false)
  })

  it('disables previews when the workspace browser provider is unavailable', () => {
    expect(
      canOpenDiffSectionPreviewToSide({
        path: 'docs/demo.html',
        status: 'modified',
        isCommitSurface: false,
        canOpenWorkspaceFileBrowser: false
      })
    ).toBe(false)
  })
})
