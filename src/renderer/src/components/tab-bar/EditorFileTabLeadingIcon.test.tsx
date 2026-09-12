import { describe, expect, it } from 'vitest'
import { Eye, GitCompareArrows, ListChecks, ShieldAlert, Smartphone } from 'lucide-react'
import type { OpenFile } from '../../store/slices/editor'
import { EditorFileTabLeadingIcon } from './EditorFileTabLeadingIcon'

function openFile(overrides: Partial<OpenFile>): OpenFile {
  return {
    id: 'file-1',
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    isPreview: false,
    isDirty: false,
    mode: 'edit',
    ...overrides
  } as OpenFile
}

/**
 * Simulator tabs reuse the editor tab chrome with a device name as their `filePath`, so the
 * file-type lookup has no extension to work from. Collapsed to an icon that glyph is the only
 * thing identifying the tab, so a generic document icon makes it unreadable.
 */
describe('EditorFileTabLeadingIcon', () => {
  it('gives a simulator tab the device glyph, not a file-type guess', () => {
    const icon = EditorFileTabLeadingIcon({
      file: openFile({
        language: 'simulator',
        filePath: 'iPhone 16 Pro',
        relativePath: 'iPhone 16 Pro'
      }),
      isActive: true
    })

    expect(icon.type).toBe(Smartphone)
  })

  it('still types a real file off its path', () => {
    const icon = EditorFileTabLeadingIcon({ file: openFile({}), isActive: true })

    expect(icon.type).not.toBe(Smartphone)
  })

  // The view mode has to outrank the file type: a conflict review of `App.tsx` is a conflict first.
  it.each([
    ['conflict-review', ShieldAlert],
    ['check-details', ListChecks],
    ['diff', GitCompareArrows],
    ['markdown-preview', Eye]
  ] as const)('renders the %s glyph regardless of file type', (mode, expected) => {
    const icon = EditorFileTabLeadingIcon({ file: openFile({ mode }), isActive: true })

    expect(icon.type).toBe(expected)
  })

  it('keeps the conflict-review glyph amber and dims it when inactive', () => {
    const active = EditorFileTabLeadingIcon({
      file: openFile({ mode: 'conflict-review' }),
      isActive: true
    })
    const inactive = EditorFileTabLeadingIcon({
      file: openFile({ mode: 'conflict-review' }),
      isActive: false
    })

    expect(active.props.className).toContain('text-orange-400')
    expect(active.props.className).not.toContain('text-orange-400/70')
    expect(inactive.props.className).toContain('text-orange-400/70')
  })
})
