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
      '⌘⌥→ was ignored — it conflicts with Worktree History Forward.'
    ])
  })

  it('leaves the other claimant alone when only the custom binding is dropped', () => {
    // Why: worktree.history.forward keeps its own default and never stopped
    // working, so a warning on its row would blame an action the user did not
    // touch — and calling it "ignored" would be false.
    const warnings = buildKeybindingConflictWarnings(
      snapshotWith({ common: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] } }),
      'darwin',
      []
    )

    expect(warnings.has('worktree.history.forward')).toBe(false)
    expect([...warnings.keys()]).toEqual(['terminal.splitRight'])
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

  it('stays silent for an override the loader kept in the active map', () => {
    // Why: "was ignored" is a claim about what the loader took away, so an
    // override that survived into the active map must not be flagged.
    const warnings = buildKeybindingConflictWarnings(
      snapshotWith({
        common: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] },
        active: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] }
      }),
      'darwin',
      []
    )

    expect(warnings.size).toBe(0)
  })
})
