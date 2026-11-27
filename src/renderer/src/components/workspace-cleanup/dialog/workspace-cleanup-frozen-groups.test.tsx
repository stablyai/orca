// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { makeFacetCandidate as makeCandidate } from '../query/workspace-cleanup-facet.test.fixture'
import {
  freezeWorkspaceCleanupGroups,
  useWorkspaceCleanupFrozenGroups
} from './workspace-cleanup-frozen-groups'

const NO_PENDING: ReadonlySet<string> = new Set()
const UNCHECKED = { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }

function row(name: string, overrides: Partial<WorkspaceCleanupCandidate> = {}) {
  return makeCandidate({ worktreeId: `repo-1::/repo/${name}`, displayName: name, ...overrides })
}
const dirty = (name: string) =>
  row(name, { blockers: ['dirty-files'], git: { ...row(name).git, clean: false } })

describe('freezeWorkspaceCleanupGroups', () => {
  it('admits a row only once its git answer is known, in a later batch than earlier rows', () => {
    const early = row('a')
    const waiting = row('b', { git: UNCHECKED })
    const first = freezeWorkspaceCleanupGroups(
      new Map(),
      [early, waiting],
      true,
      new Set([waiting.worktreeId])
    )
    expect([...first.values()].map(({ group, batch }) => ({ group, batch }))).toEqual([
      { group: 'nothing-local', batch: 0 }
    ])

    const second = freezeWorkspaceCleanupGroups(first, [early, row('b')], true, NO_PENDING)
    expect([...second.values()].map((entry) => entry.batch)).toEqual([0, 1])
  })

  it('never moves an admitted row when its data changes', () => {
    const frozen = freezeWorkspaceCleanupGroups(new Map(), [row('a')], false, NO_PENDING)
    const [identity] = [...frozen.keys()]
    const again = freezeWorkspaceCleanupGroups(frozen, [dirty('a')], false, NO_PENDING)
    expect(again.get(identity)?.group).toBe('nothing-local')
  })

  it('holds a row with no git answer until the checks have run, then admits it', () => {
    const silent = row('a', { git: UNCHECKED })
    expect(freezeWorkspaceCleanupGroups(new Map(), [silent], false, NO_PENDING).size).toBe(0)
    expect(freezeWorkspaceCleanupGroups(new Map(), [silent], true, NO_PENDING).size).toBe(1)
  })
})

describe('useWorkspaceCleanupFrozenGroups', () => {
  type Props = { candidates: WorkspaceCleanupCandidate[]; scanning: boolean }
  const mount = (initial: Props) =>
    renderHook(
      ({ candidates, scanning }: Props) =>
        useWorkspaceCleanupFrozenGroups({
          candidates,
          open: true,
          scanning,
          gitPendingWorktreeIds: NO_PENDING,
          gitChecksStarted: true,
          selectedIds: NO_PENDING
        }),
      { initialProps: initial }
    )

  it('keeps a row in its group until the user refreshes', () => {
    const { result, rerender } = mount({ candidates: [row('a')], scanning: false })
    expect(result.current.getFrozenGroup(row('a'))?.group).toBe('nothing-local')

    rerender({ candidates: [dirty('a')], scanning: false })
    expect(result.current.getFrozenGroup(dirty('a'))?.group).toBe('nothing-local')
  })

  it('shows the old groups during a refresh scan, then applies the new results', () => {
    const { result, rerender } = mount({ candidates: [row('a')], scanning: false })
    act(() => result.current.resetGroups())
    rerender({ candidates: [row('a')], scanning: true })
    // The previous scan's rows must not be captured as the refresh's result.
    rerender({ candidates: [dirty('a')], scanning: true })
    expect(result.current.getFrozenGroup(dirty('a'))?.group).toBe('nothing-local')

    rerender({ candidates: [dirty('a')], scanning: false })
    expect(result.current.getFrozenGroup(dirty('a'))?.group).toBe('local-files')
  })
})
