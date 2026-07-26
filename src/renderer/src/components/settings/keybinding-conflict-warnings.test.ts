import { describe, expect, it } from 'vitest'
import type { KeybindingFileSnapshot, KeybindingOverrides } from '../../../../shared/keybindings'
import { buildKeybindingConflictWarnings } from './keybinding-conflict-warnings'

function snapshotWith(options: {
  common?: KeybindingOverrides
  darwin?: KeybindingOverrides
  active?: KeybindingOverrides
}): KeybindingFileSnapshot {
  return {
    path: '/tmp/keybindings.json',
    platform: 'darwin',
    exists: true,
    // The loader hands the app a sanitized map; conflicting entries are gone.
    overrides: options.active ?? {},
    commonOverrides: options.common ?? {},
    platformOverrides: { darwin: options.darwin ?? {}, linux: {}, win32: {} },
    diagnostics: []
  }
}

describe('buildKeybindingConflictWarnings', () => {
  it('reports a binding the loader dropped from the active map', () => {
    // Why: this is the regression. terminal.splitRight loses Mod+Alt+ArrowRight
    // to worktree.history.forward, the loader strips it, and judging the
    // stripped map reported zero conflicts with no explanation.
    const warnings = buildKeybindingConflictWarnings(
      snapshotWith({ common: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] }, active: {} }),
      'darwin',
      []
    )

    expect(warnings.get('terminal.splitRight')).toEqual([
      '⌘⌥→ conflicts with Worktree History Forward.'
    ])
    expect(warnings.get('worktree.history.forward')).toEqual([
      '⌘⌥→ conflicts with Split terminal right.'
    ])
  })

  it('names only the other claimants, never the row itself', () => {
    const warnings = buildKeybindingConflictWarnings(
      snapshotWith({ common: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] } }),
      'darwin',
      []
    )

    for (const [actionId, messages] of warnings) {
      const ownTitle = actionId === 'terminal.splitRight' ? 'Split terminal right' : null
      if (ownTitle) {
        expect(messages.join(' ')).not.toContain(ownTitle)
      }
    }
  })

  it('prefers the platform layer over the common layer', () => {
    const warnings = buildKeybindingConflictWarnings(
      snapshotWith({
        common: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] },
        darwin: { 'terminal.splitRight': ['Mod+Shift+F19'] }
      }),
      'darwin',
      []
    )

    expect(warnings.size).toBe(0)
  })

  it('stays empty for a file with no conflicting bindings', () => {
    expect(
      buildKeybindingConflictWarnings(
        snapshotWith({ common: { 'terminal.splitRight': ['Mod+Shift+F19'] } }),
        'darwin',
        []
      ).size
    ).toBe(0)
    expect(buildKeybindingConflictWarnings(null, 'darwin', []).size).toBe(0)
  })

  it('honors ignored actions', () => {
    expect(
      buildKeybindingConflictWarnings(
        snapshotWith({ common: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] } }),
        'darwin',
        ['terminal.splitRight']
      ).size
    ).toBe(0)
  })
})
