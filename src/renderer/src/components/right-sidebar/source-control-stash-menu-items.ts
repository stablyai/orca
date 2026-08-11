import { translate } from '@/i18n/i18n'
import type {
  DropdownItem,
  DropdownSeparator,
  DropdownSubmenu
} from './source-control-dropdown-items'

export type StashMenuInputs = {
  /** Tracked modifications, staged or unstaged. */
  hasTrackedChanges: boolean
  untrackedCount: number
  /** undefined until the list has been read — rows show a loading reason. */
  stashCount: number | undefined
  globalBusy: boolean
}

/**
 * Build the Stash group for the commit dropdown: save actions, then restore
 * actions, then the destructive ones. Every row is always rendered — disabled
 * with a reason in its tooltip — so the menu shape stays stable and testable,
 * matching the invariant the sibling rows in source-control-dropdown-items
 * follow.
 */
export function resolveStashSubmenu(inputs: StashMenuInputs): DropdownSubmenu {
  const { hasTrackedChanges, untrackedCount, stashCount, globalBusy } = inputs
  const hasAnyChanges = hasTrackedChanges || untrackedCount > 0
  const loading = stashCount === undefined
  const stashes = stashCount ?? 0
  const hasStashes = stashes > 0

  const busyReason = translate(
    'auto.components.right.sidebar.source.control.stash.menu.items.busy',
    'Another git operation is in progress…'
  )
  const loadingReason = translate(
    'auto.components.right.sidebar.source.control.stash.menu.items.loading',
    'Checking stashes…'
  )
  const nothingToStash = translate(
    'auto.components.right.sidebar.source.control.stash.menu.items.nothing',
    'Nothing to stash'
  )
  const untrackedOnly = translate(
    'auto.components.right.sidebar.source.control.stash.menu.items.untrackedOnly',
    'Only untracked files — use Stash (Include Untracked)'
  )

  // Why: a shared resolver keeps "busy beats loading beats empty" consistent, so
  // no row can claim "No stashes" while the count is still unknown.
  function restoreReason(available: string, emptyReason: string): string {
    if (globalBusy) {
      return busyReason
    }
    if (loading) {
      return loadingReason
    }
    return hasStashes ? available : emptyReason
  }
  const restoreDisabled = globalBusy || loading || !hasStashes

  const noneToPop = translate(
    'auto.components.right.sidebar.source.control.stash.menu.items.noPop',
    'No stashes to pop'
  )
  const noneToApply = translate(
    'auto.components.right.sidebar.source.control.stash.menu.items.noApply',
    'No stashes to apply'
  )
  const noneToDrop = translate(
    'auto.components.right.sidebar.source.control.stash.menu.items.noDrop',
    'No stashes to drop'
  )

  const items: (DropdownItem | DropdownSeparator)[] = [
    {
      kind: 'stash',
      label: translate(
        'auto.components.right.sidebar.source.control.stash.menu.items.stash',
        'Stash'
      ),
      title: globalBusy
        ? busyReason
        : hasTrackedChanges
          ? translate(
              'auto.components.right.sidebar.source.control.stash.menu.items.stashHint',
              'Stash tracked changes and restore a clean working tree'
            )
          : untrackedCount > 0
            ? untrackedOnly
            : nothingToStash,
      disabled: globalBusy || !hasTrackedChanges
    },
    {
      kind: 'stash_include_untracked',
      label: translate(
        'auto.components.right.sidebar.source.control.stash.menu.items.stashUntracked',
        'Stash (Include Untracked)'
      ),
      title: globalBusy
        ? busyReason
        : hasAnyChanges
          ? translate(
              'auto.components.right.sidebar.source.control.stash.menu.items.stashUntrackedHint',
              'Stash tracked and untracked changes'
            )
          : nothingToStash,
      disabled: globalBusy || !hasAnyChanges
    },
    { kind: 'separator' },
    {
      kind: 'stash_pop_latest',
      label: formatStashCountLabel(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.popLatest',
          'Pop Latest Stash'
        ),
        stashes
      ),
      title: restoreReason(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.popLatestHint',
          'Apply the most recent stash and remove it from the list'
        ),
        noneToPop
      ),
      disabled: restoreDisabled
    },
    {
      kind: 'stash_pop_pick',
      label: translate(
        'auto.components.right.sidebar.source.control.stash.menu.items.popPick',
        'Pop Stash…'
      ),
      title: restoreReason(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.popPickHint',
          'Choose a stash to apply and remove'
        ),
        noneToPop
      ),
      disabled: restoreDisabled
    },
    {
      kind: 'stash_apply_latest',
      label: formatStashCountLabel(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.applyLatest',
          'Apply Latest Stash'
        ),
        stashes
      ),
      title: restoreReason(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.applyLatestHint',
          'Apply the most recent stash and keep it in the list'
        ),
        noneToApply
      ),
      disabled: restoreDisabled
    },
    {
      kind: 'stash_apply_pick',
      label: translate(
        'auto.components.right.sidebar.source.control.stash.menu.items.applyPick',
        'Apply Stash…'
      ),
      title: restoreReason(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.applyPickHint',
          'Choose a stash to apply and keep'
        ),
        noneToApply
      ),
      disabled: restoreDisabled
    },
    { kind: 'separator' },
    {
      kind: 'stash_drop_pick',
      label: translate(
        'auto.components.right.sidebar.source.control.stash.menu.items.dropPick',
        'Drop Stash…'
      ),
      title: restoreReason(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.dropPickHint',
          'Choose a stash to delete permanently'
        ),
        noneToDrop
      ),
      disabled: restoreDisabled,
      variant: 'destructive'
    },
    {
      kind: 'stash_drop_all',
      label: formatStashCountLabel(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.dropAll',
          'Drop All Stashes…'
        ),
        stashes
      ),
      title: restoreReason(
        translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.dropAllHint',
          'Delete every stash permanently'
        ),
        noneToDrop
      ),
      disabled: restoreDisabled,
      variant: 'destructive'
    }
  ]

  return {
    kind: 'stash_submenu',
    label: translate(
      'auto.components.right.sidebar.source.control.stash.menu.items.group',
      'Stash'
    ),
    title: resolveSubmenuTitle({ globalBusy, loading, stashes, hasAnyChanges }),
    // Why: never hard-disable the trigger on an empty list — the group still
    // opens so each row's tooltip can explain which action is unavailable.
    disabled: globalBusy,
    items
  }
}

function resolveSubmenuTitle(inputs: {
  globalBusy: boolean
  loading: boolean
  stashes: number
  hasAnyChanges: boolean
}): string {
  if (inputs.globalBusy) {
    return translate(
      'auto.components.right.sidebar.source.control.stash.menu.items.busy',
      'Another git operation is in progress…'
    )
  }
  if (inputs.loading) {
    return translate(
      'auto.components.right.sidebar.source.control.stash.menu.items.loading',
      'Checking stashes…'
    )
  }
  if (inputs.stashes > 0) {
    return inputs.stashes === 1
      ? translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.groupOne',
          '1 stash available'
        )
      : translate(
          'auto.components.right.sidebar.source.control.stash.menu.items.groupMany',
          '{{value0}} stashes available',
          { value0: inputs.stashes }
        )
  }
  return inputs.hasAnyChanges
    ? translate(
        'auto.components.right.sidebar.source.control.stash.menu.items.groupStashOnly',
        'Stash changes; no stashes to restore yet'
      )
    : translate(
        'auto.components.right.sidebar.source.control.stash.menu.items.groupEmpty',
        'No changes to stash and no stashes to restore'
      )
}

function formatStashCountLabel(base: string, count: number): string {
  return count > 0 ? `${base} (${count})` : base
}
