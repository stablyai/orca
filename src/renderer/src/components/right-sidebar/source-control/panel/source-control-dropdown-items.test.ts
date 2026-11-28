import { describe, expect, it } from 'vitest'
import type {
  DropdownActionInputs,
  DropdownActionKind
} from '../../../../../../shared/source-control/dropdown/source-control-dropdown-item-types'
import { resolveDropdownItems } from './source-control-dropdown-items'
import { CHANGED_STATES, STATES } from './source-control-dropdown-items.test-fixture'

// Actions main's menu could run in each state: enabled and not idle (Force Push and Fetch always
// count), read from main's row builders. Rebase at ↓0 is idle, as UX asked (it would run nothing).
const MAIN_ENABLED: Record<string, DropdownActionKind[]> = {
  behindBase: ['force_push', 'rebase_base', 'fetch'],
  upToDateWithBase: ['force_push', 'fetch'],
  staged: ['commit', 'commit_push', 'commit_sync', 'force_push', 'rebase_base', 'fetch'],
  stagedWithoutMessage: ['force_push', 'rebase_base', 'fetch'],
  dirty: ['force_push', 'rebase_base', 'fetch'],
  ahead: ['push', 'force_push', 'sync', 'rebase_base', 'fetch'],
  behindUpstream: ['force_push', 'pull', 'fast_forward', 'sync', 'rebase_base', 'fetch'],
  diverged: ['push', 'force_push', 'pull', 'fast_forward', 'sync', 'rebase_base', 'fetch'],
  justRebased: ['push', 'force_push', 'rebase_base', 'fetch'],
  unpublished: ['push', 'force_push', 'rebase_base', 'fetch', 'publish'],
  pushedNoPr: ['force_push', 'rebase_base', 'fetch', 'create_pr'],
  aheadNoPr: ['push', 'force_push', 'sync', 'rebase_base', 'fetch', 'create_pr', 'push_create_pr'],
  mergeConflict: ['force_push', 'rebase_base', 'fetch'],
  rebaseConflict: ['fetch'],
  busy: []
}

function menuRows(inputs: DropdownActionInputs): string[] {
  return resolveDropdownItems(inputs).map((entry) =>
    entry.kind === 'separator' ? '---' : `${entry.kind}${entry.status ? ` ${entry.status}` : ''}`
  )
}

/** The menu's enabled rows plus the action the primary button runs. */
function reachable(inputs: DropdownActionInputs): string[] {
  const kinds = new Set<string>()
  for (const entry of resolveDropdownItems(inputs)) {
    if (entry.kind !== 'separator' && !entry.disabled) {
      kinds.add(entry.kind)
    }
  }
  const primary = inputs.primaryActionKind
  const forced = inputs.upstreamStatus?.behindCommitsArePatchEquivalent === true
  if (primary === 'push') {
    kinds.add(forced ? 'force_push' : 'push')
  } else if (primary === 'create_pr_intent') {
    kinds.add('push_create_pr')
  } else if (primary && primary !== 'stage') {
    kinds.add(primary)
  }
  return [...kinds]
}

describe('resolveDropdownItems keeps every action main could run reachable', () => {
  it.each(Object.keys(MAIN_ENABLED))('%s', (name) => {
    const inputs = STATES[name]
    // A paused rebase lists Abort/Continue instead of Rebase; the commit area is hidden then anyway.
    const exempt = inputs.conflictOperation === 'rebase' ? ['rebase_base'] : []
    expect(reachable(inputs)).toEqual(
      expect.arrayContaining(MAIN_ENABLED[name].filter((kind) => !exempt.includes(kind)))
    )
    // No greyed rows: only Fetch may be listed disabled, as the menu's always-present refresh.
    expect(
      resolveDropdownItems(inputs).filter(
        (entry) => entry.kind !== 'separator' && entry.disabled && entry.kind !== 'fetch'
      )
    ).toEqual([])
  })
})

describe('resolveDropdownItems order and labels', () => {
  it('leads with Rebase and its behind count when the branch is behind its base', () => {
    expect(menuRows(STATES.behindBase)).toEqual(['rebase_base ↓299', '---', 'force_push', 'fetch'])
  })

  it('keeps Commit & Push / Sync but not the Commit the primary already runs', () => {
    expect(menuRows(STATES.staged)).toEqual([
      'commit_push',
      'commit_sync',
      'rebase_base ↓299',
      '---',
      'force_push',
      'fetch'
    ])
  })

  it('lists no idle rows once the branch is up to date, keeping Force Push and Fetch', () => {
    expect(menuRows(STATES.upToDateWithBase)).toEqual(['force_push', 'fetch'])
  })

  it('drops the Push, Force Push or Create PR row that the primary button runs', () => {
    expect(menuRows(STATES.ahead).some((row) => row.startsWith('push'))).toBe(false)
    expect(menuRows(STATES.justRebased).some((row) => row.startsWith('force_push'))).toBe(false)
    expect(menuRows(STATES.pushedNoPr)).not.toContain('create_pr')
  })

  it('keeps merge-conflict Abort as on main', () => {
    expect(menuRows(STATES.mergeConflict).at(-1)).toBe('abort_merge')
  })
})

describe('resolveDropdownItems owner-approved differences from main', () => {
  it('hides Rebase while tracked edits would make Git refuse it', () => {
    expect(menuRows(CHANGED_STATES.dirtyWithoutAutoStash)).not.toContain('rebase_base ↓299')
    expect(menuRows(STATES.dirty)).toContain('rebase_base ↓299')
  })

  it('hides Pull, Sync, Fast-forward and Push after Orca rebased, keeping Force Push', () => {
    expect(menuRows(CHANGED_STATES.orcaRebased)).toEqual(['force_push Replaces ↓2', 'fetch'])
  })

  it('hides Commit & Sync after Orca rebased, even with staged changes', () => {
    const staged = { ...CHANGED_STATES.orcaRebased, stagedCount: 3, hasMessage: true }
    expect(menuRows(staged)).toContain('commit_push')
    expect(menuRows(staged)).not.toContain('commit_sync')
  })

  it('limits a paused rebase to Abort, Continue once resolved, and Fetch', () => {
    expect(menuRows(STATES.rebaseConflict)).toEqual(['abort_rebase', '---', 'fetch'])
    expect(menuRows(CHANGED_STATES.rebaseResolved)).toEqual([
      'abort_rebase',
      'continue_rebase',
      '---',
      'fetch'
    ])
  })
})
