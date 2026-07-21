/**
 * Unit coverage for the pure predicates/reducer behind the #8881 store purge.
 *
 * The removal-diff scoping is the load-bearing safety property: `isRemovedRuntimeHostId`
 * may only match runtime hosts whose env id is in the *removed* (tombstoned) set —
 * never local/ssh/unhosted, and never a runtime host merely absent from a
 * not-yet-hydrated saved list. The reducer must preserve reference identity when
 * nothing changed so it never churns the render pipeline.
 */
import { describe, it, expect } from 'vitest'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  isRemovedRuntimeHostId,
  dropWorktreeRowsForRemovedRuntimeEnvironments
} from './stale-runtime-host-rows'

const runtimeA = toRuntimeExecutionHostId('env-a')
const runtimeB = toRuntimeExecutionHostId('env-b')

type Row = { id: string; hostId?: ExecutionHostId }

function row(id: string, hostId?: ExecutionHostId): Row {
  return { id, hostId }
}

describe('isRemovedRuntimeHostId', () => {
  it('is true for a runtime host whose env id is in the removed set', () => {
    expect(isRemovedRuntimeHostId(runtimeA, new Set(['env-a']))).toBe(true)
  })

  it('is false for a runtime host NOT in the removed set', () => {
    expect(isRemovedRuntimeHostId(runtimeB, new Set(['env-a']))).toBe(false)
  })

  it('is false for local, ssh, and undefined host ids', () => {
    const removed = new Set(['env-a'])
    expect(isRemovedRuntimeHostId('local', removed)).toBe(false)
    expect(isRemovedRuntimeHostId('ssh:my-server', removed)).toBe(false)
    expect(isRemovedRuntimeHostId(undefined, removed)).toBe(false)
    expect(isRemovedRuntimeHostId(null, removed)).toBe(false)
  })

  it('is false when the removed set is empty', () => {
    expect(isRemovedRuntimeHostId(runtimeA, new Set())).toBe(false)
  })

  it("is false for a 'local' catalog host even when a serving instance's repos carry runtime stamps", () => {
    // The catalog-merge guard keys on catalog.hostId (the fetch *target*). A serving
    // instance's own catalog is fetched as hostId 'local' regardless of the runtime:
    // stamps its repos carry, so it is exempt by construction.
    expect(isRemovedRuntimeHostId('local', new Set(['env-a']))).toBe(false)
  })
})

describe('dropWorktreeRowsForRemovedRuntimeEnvironments', () => {
  it('drops matching runtime rows and reports their ids', () => {
    const rowsByRepo = {
      repo1: [row('w-local', 'local'), row('w-a', runtimeA)]
    }
    const result = dropWorktreeRowsForRemovedRuntimeEnvironments(rowsByRepo, new Set(['env-a']))
    expect(result.rowsByRepo.repo1).toEqual([row('w-local', 'local')])
    expect(result.removedWorktreeIds).toEqual(['w-a'])
  })

  it('returns the SAME reference with empty ids when nothing matches', () => {
    const rowsByRepo = { repo1: [row('w-local', 'local'), row('w-b', runtimeB)] }
    const result = dropWorktreeRowsForRemovedRuntimeEnvironments(rowsByRepo, new Set(['env-a']))
    expect(result.rowsByRepo).toBe(rowsByRepo)
    expect(result.removedWorktreeIds).toEqual([])
  })

  it('returns the SAME reference with empty ids when the removed set is empty', () => {
    const rowsByRepo = { repo1: [row('w-a', runtimeA)] }
    const result = dropWorktreeRowsForRemovedRuntimeEnvironments(rowsByRepo, new Set())
    expect(result.rowsByRepo).toBe(rowsByRepo)
    expect(result.removedWorktreeIds).toEqual([])
  })

  it('keeps the repo key even when all of its rows drop', () => {
    const rowsByRepo = { repoA: [row('w-a1', runtimeA), row('w-a2', runtimeA)] }
    const result = dropWorktreeRowsForRemovedRuntimeEnvironments(rowsByRepo, new Set(['env-a']))
    expect(Object.keys(result.rowsByRepo)).toEqual(['repoA'])
    expect(result.rowsByRepo.repoA).toEqual([])
    expect(result.removedWorktreeIds).toEqual(['w-a1', 'w-a2'])
  })

  it('gives only the changed repo a new array; unchanged repos keep their reference', () => {
    const unchanged = [row('w-local', 'local')]
    const changing = [row('w-keep', 'local'), row('w-a', runtimeA)]
    const rowsByRepo = { repoUnchanged: unchanged, repoChanging: changing }
    const result = dropWorktreeRowsForRemovedRuntimeEnvironments(rowsByRepo, new Set(['env-a']))
    // A change anywhere returns a new top-level map...
    expect(result.rowsByRepo).not.toBe(rowsByRepo)
    // ...the untouched repo keeps its exact original array reference...
    expect(result.rowsByRepo.repoUnchanged).toBe(unchanged)
    // ...and only the changed repo gets a fresh filtered array.
    expect(result.rowsByRepo.repoChanging).not.toBe(changing)
    expect(result.rowsByRepo.repoChanging).toEqual([row('w-keep', 'local')])
  })

  it('drops unhosted rows only for an unambiguously removed sole-owner repo', () => {
    const rowsByRepo = {
      removedRepo: [row('w-legacy')],
      ambiguousRepo: [row('w-ambiguous')]
    }
    const result = dropWorktreeRowsForRemovedRuntimeEnvironments(
      rowsByRepo,
      new Set(['env-a']),
      new Set(['removedRepo'])
    )

    expect(result.rowsByRepo.removedRepo).toEqual([])
    expect(result.rowsByRepo.ambiguousRepo).toEqual([row('w-ambiguous')])
    expect(result.removedWorktreeIds).toEqual(['w-legacy'])
  })
})
