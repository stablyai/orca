import { describe, expect, it } from 'vitest'
import { resolveStashSubmenu, type StashMenuInputs } from './source-control-stash-menu-items'
import {
  resolveDropdownItems,
  type DropdownActionInputs,
  type DropdownItem
} from './source-control-dropdown-items'

function stashInputs(overrides: Partial<StashMenuInputs> = {}): StashMenuInputs {
  return {
    hasTrackedChanges: false,
    untrackedCount: 0,
    stashCount: 0,
    globalBusy: false,
    ...overrides
  }
}

function rowsByKind(inputs: StashMenuInputs): Record<string, DropdownItem> {
  const submenu = resolveStashSubmenu(inputs)
  return Object.fromEntries(
    submenu.items
      .filter((item): item is DropdownItem => item.kind !== 'separator')
      .map((item) => [item.kind, item])
  )
}

describe('resolveStashSubmenu', () => {
  it('renders all eight rows in order, with the two destructive rows split off', () => {
    const submenu = resolveStashSubmenu(stashInputs())
    expect(submenu.items.map((item) => item.kind)).toEqual([
      'stash',
      'stash_include_untracked',
      'separator',
      'stash_pop_latest',
      'stash_pop_pick',
      'stash_apply_latest',
      'stash_apply_pick',
      'separator',
      'stash_drop_pick',
      'stash_drop_all'
    ])
  })

  it('marks only the delete rows destructive', () => {
    const rows = rowsByKind(stashInputs({ stashCount: 2 }))
    expect(rows.stash_drop_pick.variant).toBe('destructive')
    expect(rows.stash_drop_all.variant).toBe('destructive')
    expect(rows.stash_pop_latest.variant).toBeUndefined()
    expect(rows.stash.variant).toBeUndefined()
  })

  it('keeps the group openable while empty so each row can explain itself', () => {
    // Why: the invariant is "always rendered, disabled with a reason" — hiding
    // the group would leave the user with no explanation at all.
    const submenu = resolveStashSubmenu(stashInputs())
    expect(submenu.disabled).toBe(false)
    expect(submenu.title).toBe('No changes to stash and no stashes to restore')
  })

  describe('stash rows', () => {
    it('disables both when the tree is clean', () => {
      const rows = rowsByKind(stashInputs())
      expect(rows.stash.disabled).toBe(true)
      expect(rows.stash.title).toBe('Nothing to stash')
      expect(rows.stash_include_untracked.disabled).toBe(true)
      expect(rows.stash_include_untracked.title).toBe('Nothing to stash')
    })

    it('enables both when tracked changes exist', () => {
      const rows = rowsByKind(stashInputs({ hasTrackedChanges: true }))
      expect(rows.stash.disabled).toBe(false)
      expect(rows.stash.title).toBe('Stash tracked changes and restore a clean working tree')
      expect(rows.stash_include_untracked.disabled).toBe(false)
    })

    it('points an untracked-only tree at the include-untracked row', () => {
      // Why: plain `git stash` would report "no local changes to save" here, so
      // the disabled reason has to name the row that actually works.
      const rows = rowsByKind(stashInputs({ untrackedCount: 3 }))
      expect(rows.stash.disabled).toBe(true)
      expect(rows.stash.title).toBe('Only untracked files — use Stash (Include Untracked)')
      expect(rows.stash_include_untracked.disabled).toBe(false)
      expect(rows.stash_include_untracked.title).toBe('Stash tracked and untracked changes')
    })
  })

  describe('restore rows', () => {
    it('disables them with a loading reason while the count is unknown', () => {
      const rows = rowsByKind(stashInputs({ stashCount: undefined }))
      for (const kind of [
        'stash_pop_latest',
        'stash_pop_pick',
        'stash_apply_latest',
        'stash_apply_pick',
        'stash_drop_pick',
        'stash_drop_all'
      ]) {
        expect(rows[kind].disabled).toBe(true)
        // Why: an unknown count must never be reported as "no stashes".
        expect(rows[kind].title).toBe('Checking stashes…')
      }
    })

    it('gives each row its own empty reason', () => {
      const rows = rowsByKind(stashInputs({ stashCount: 0 }))
      expect(rows.stash_pop_latest.title).toBe('No stashes to pop')
      expect(rows.stash_apply_pick.title).toBe('No stashes to apply')
      expect(rows.stash_drop_all.title).toBe('No stashes to drop')
    })

    it('enables them and counts the stashes once the list is known', () => {
      const rows = rowsByKind(stashInputs({ stashCount: 3 }))
      expect(rows.stash_pop_latest.disabled).toBe(false)
      expect(rows.stash_pop_latest.label).toBe('Pop Latest Stash (3)')
      expect(rows.stash_apply_latest.label).toBe('Apply Latest Stash (3)')
      expect(rows.stash_drop_all.label).toBe('Drop All Stashes… (3)')
      expect(rows.stash_pop_pick.label).toBe('Pop Stash…')
      expect(rows.stash_apply_pick.label).toBe('Apply Stash…')
      expect(rows.stash_drop_pick.label).toBe('Drop Stash…')
    })

    it('omits the count suffix when there are no stashes', () => {
      expect(rowsByKind(stashInputs()).stash_pop_latest.label).toBe('Pop Latest Stash')
    })

    it('distinguishes pop from apply in the hints', () => {
      const rows = rowsByKind(stashInputs({ stashCount: 1 }))
      expect(rows.stash_pop_latest.title).toContain('remove it from the list')
      expect(rows.stash_apply_latest.title).toContain('keep it in the list')
    })
  })

  it('locks every row and the trigger while another git operation runs', () => {
    const submenu = resolveStashSubmenu(
      stashInputs({ hasTrackedChanges: true, stashCount: 2, globalBusy: true })
    )
    expect(submenu.disabled).toBe(true)
    for (const item of submenu.items) {
      if (item.kind === 'separator') {
        continue
      }
      expect(item.disabled).toBe(true)
      expect(item.title).toBe('Another git operation is in progress…')
    }
  })

  it('summarizes the available stashes on the group trigger', () => {
    expect(resolveStashSubmenu(stashInputs({ stashCount: 1 })).title).toBe('1 stash available')
    expect(resolveStashSubmenu(stashInputs({ stashCount: 4 })).title).toBe('4 stashes available')
    expect(resolveStashSubmenu(stashInputs({ hasTrackedChanges: true })).title).toBe(
      'Stash changes; no stashes to restore yet'
    )
  })
})

// Integration with the parent menu — the submenu is only useful if it is wired
// with the right inputs and survives the hosted-review lockout correctly.
describe('stash group inside the commit dropdown', () => {
  function inputs(overrides: Partial<DropdownActionInputs> = {}): DropdownActionInputs {
    return {
      stagedCount: 0,
      hasUnstagedChanges: false,
      hasStageableChanges: false,
      hasPartiallyStagedChanges: false,
      hasMessage: false,
      hasUnresolvedConflicts: false,
      isCommitting: false,
      isRemoteOperationActive: false,
      upstreamStatus: undefined,
      ...overrides
    }
  }

  function submenuOf(overrides: Partial<DropdownActionInputs>) {
    const entry = resolveDropdownItems(inputs(overrides)).find(
      (item) => item.kind === 'stash_submenu'
    )
    if (!entry || entry.kind !== 'stash_submenu') {
      throw new Error('stash submenu missing from the dropdown')
    }
    return entry
  }

  it('treats staged-only changes as stashable', () => {
    const rows = submenuOf({ stagedCount: 2, stashCount: 0 }).items
    const stashRow = rows.find((row) => row.kind === 'stash')
    expect(stashRow && stashRow.kind !== 'separator' && stashRow.disabled).toBe(false)
  })

  function stashRowsOf(overrides: Partial<DropdownActionInputs>): Record<string, DropdownItem> {
    return Object.fromEntries(
      submenuOf(overrides)
        .items.filter((row): row is DropdownItem => row.kind !== 'separator')
        .map((r) => [r.kind, r])
    )
  }

  it('disables plain Stash for an untracked-only tree', () => {
    // Why: `hasUnstagedChanges` is true for untracked files too, so the submenu
    // cannot infer tracked-vs-untracked from it. Getting this wrong enables
    // Stash on an untracked-only tree, where `git stash push` exits 0 with
    // "No local changes to save" and the user gets a confusing no-op.
    const rows = stashRowsOf({
      hasUnstagedChanges: true,
      untrackedCount: 2,
      trackedChangeCount: 0,
      stashCount: 0
    })

    expect(rows.stash.disabled).toBe(true)
    expect(rows.stash.title).toBe('Only untracked files — use Stash (Include Untracked)')
    expect(rows.stash_include_untracked.disabled).toBe(false)
  })

  it('enables plain Stash when a tracked file is modified alongside untracked ones', () => {
    const rows = stashRowsOf({
      hasUnstagedChanges: true,
      untrackedCount: 2,
      trackedChangeCount: 1,
      stashCount: 0
    })

    expect(rows.stash.disabled).toBe(false)
    expect(rows.stash_include_untracked.disabled).toBe(false)
  })

  it('treats staged files as tracked without needing an explicit count', () => {
    const rows = stashRowsOf({ stagedCount: 2, stashCount: 0 })
    expect(rows.stash.disabled).toBe(false)
  })

  it('disables the group and its rows during a hosted review operation', () => {
    const submenu = submenuOf({
      stagedCount: 1,
      stashCount: 2,
      isPullRequestOperationActive: true
    })
    expect(submenu.disabled).toBe(true)
    expect(submenu.title).toBe('Hosted review operation in progress…')
    for (const item of submenu.items) {
      if (item.kind === 'separator') {
        continue
      }
      // Why: disabling only the trigger would leave enabled-looking rows inside.
      expect(item.disabled).toBe(true)
      expect(item.title).toBe('Hosted review operation in progress…')
    }
  })

  it('reports an unknown stash count when the caller has not read it yet', () => {
    const submenu = submenuOf({ stagedCount: 1 })
    expect(submenu.title).toBe('Checking stashes…')
  })
})
