import { describe, expect, it } from 'vitest'
import { resolveWindowShortcutAction } from './window-shortcut-policy'
import { findKeybindingActionsForBinding, findKeybindingConflicts } from './formatting'
import { getEffectiveKeybindingsForAction } from './effective'
import { resolveKeybindingOverrides } from './profile-defaults'
import { getLegacySearchBindings } from './definitions'
import { isOlderKeybindingSnapshot } from './keybinding-snapshot-generation'
import {
  inactiveFloatingWorkspaceActionIds,
  omitInactiveFloatingWorkspaceOverrides
} from '../settings/floating-workspace-cohort'
import type { KeybindingActionId, KeybindingOverrides } from './types'

const MOD_ALT_A = { type: 'keyDown', key: 'a', code: 'KeyA', meta: true, alt: true }
const INACTIVE = inactiveFloatingWorkspaceActionIds(false)

describe('floating workspace shortcut gating', () => {
  it('skips an inactive toggle so the chord falls through to whatever else owns it', () => {
    expect(resolveWindowShortcutAction(MOD_ALT_A, 'darwin')).toBeNull()
    expect(
      resolveWindowShortcutAction(MOD_ALT_A, 'darwin', undefined, {
        floatingWorkspaceShortcutsActive: true
      })
    ).toEqual({ type: 'toggleFloatingTerminal' })
    // A main-routed action remapped onto the chord still resolves while the toggle is inert.
    expect(
      resolveWindowShortcutAction(MOD_ALT_A, 'darwin', { 'app.settings': ['Mod+Alt+A'] })
    ).toEqual({ type: 'openSettings' })
  })

  it('keeps an inactive default from blocking or naming a user binding on its chord', () => {
    const userBinding: KeybindingOverrides = { 'tab.newTerminal': ['Mod+Alt+A'] }
    const conflictsFor = (ignoredActionIds: readonly KeybindingActionId[]) =>
      findKeybindingConflicts(
        'darwin',
        resolveKeybindingOverrides('darwin', userBinding, {}, ignoredActionIds),
        { includeMainProcessInterception: true, ignoredActionIds }
      ).filter((conflict) => conflict.actionIds.includes('tab.newTerminal'))
    expect(conflictsFor(INACTIVE)).toEqual([])
    expect(conflictsFor([])).not.toEqual([])
    expect(findKeybindingActionsForBinding('Mod+Alt+A', 'darwin', {}, undefined, INACTIVE)).toEqual(
      []
    )
    expect(findKeybindingActionsForBinding('Mod+Alt+A', 'darwin')).toContain(
      'floatingTerminal.toggle'
    )
  })

  it('stops an inactive override from making a yielding default give up its chord', () => {
    const file: KeybindingOverrides = { 'floatingTerminal.toggle': ['Mod+Shift+J'] }
    const published = resolveKeybindingOverrides('darwin', file, {}, INACTIVE)
    expect(published).toEqual({})
    expect(
      getEffectiveKeybindingsForAction('terminal.toggleNativeChat', 'darwin', published)
    ).toContain('Mod+Shift+J')
    // A third action may take the yielding chord; the inert remap neither blocks it nor shares it.
    const third = resolveKeybindingOverrides(
      'darwin',
      { ...file, 'workspace.openBoard': ['Mod+Shift+J'] },
      {},
      INACTIVE
    )
    expect(
      findKeybindingConflicts('darwin', third, {
        includeMainProcessInterception: true,
        ignoredActionIds: INACTIVE
      })
    ).toEqual([])
    expect(
      findKeybindingConflicts(
        'darwin',
        resolveKeybindingOverrides(
          'darwin',
          { ...file, 'workspace.openBoard': ['Mod+Shift+J'] },
          {}
        ),
        { includeMainProcessInterception: true }
      ).some((conflict) => conflict.actionIds.includes('floatingTerminal.toggle'))
    ).toBe(true)
    // Active, the same override claims the chord exactly as before.
    const active = resolveKeybindingOverrides('darwin', file, {})
    expect(
      getEffectiveKeybindingsForAction('terminal.toggleNativeChat', 'darwin', active)
    ).not.toContain('Mod+Shift+J')
  })

  it('keeps inherited defaults when only an inactive override competes for their chord', () => {
    const inherited = getLegacySearchBindings('darwin')
    const file: KeybindingOverrides = { 'floatingTerminal.toggle': ['Mod+J'] }
    expect(
      resolveKeybindingOverrides('darwin', file, inherited, INACTIVE)['worktree.palette']
    ).toEqual(['Mod+J'])
    expect(resolveKeybindingOverrides('darwin', file, inherited)['worktree.palette']).toEqual([])
  })

  it('keeps the same map object when nothing is stripped', () => {
    const overrides: KeybindingOverrides = { 'tab.newTerminal': ['Mod+T'] }
    expect(omitInactiveFloatingWorkspaceOverrides(overrides, false)).toBe(overrides)
    const withFloating = { ...overrides, 'floatingWorkspace.maximize': ['Mod+M'] }
    expect(omitInactiveFloatingWorkspaceOverrides(withFloating, true)).toBe(withFloating)
    expect(omitInactiveFloatingWorkspaceOverrides(withFloating, false)).toEqual(overrides)
  })

  it('rejects a snapshot older than the one already applied', () => {
    expect(isOlderKeybindingSnapshot({ generation: 3 }, { generation: 1 })).toBe(true)
    expect(isOlderKeybindingSnapshot({ generation: 3 }, { generation: 3 })).toBe(false)
    expect(isOlderKeybindingSnapshot(null, { generation: 1 })).toBe(false)
  })
})
