import { expect, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { worktreeFixture, detectedListingFixture } from './native-chat-workspace-test-fixtures'
import * as owners from '@/lib/resolve-owner'
import * as ownerIndex from '@/lib/worktree-runtime-owner-index'
import { selectDetectedWorktreesByRepo } from '@/store/workspace-record-selectors'

export { useAppStore } from '@/store'

export const incomingFilterWork = { nestedVisits: 0, nestedFilters: 0 }
const filterDescriptors = new Map<object, PropertyDescriptor | undefined>()

type OwnerFrame = {
  state: Parameters<typeof owners.resolveOwner>[0]
  ref: Parameters<typeof owners.resolveOwner>[1]
  arrays: Set<object>
  filters: number
}
let ownerFrame: OwnerFrame | undefined, nestedCandidate: object | undefined
export const meteredDetectedRows = new WeakSet<object>()
const realResolveOwner = owners.resolveOwner
vi.spyOn(owners, 'resolveOwner').mockImplementation((state, ref) => {
  const previous = ownerFrame
  const frame: OwnerFrame = { state, ref, arrays: new Set(), filters: 0 }
  ownerFrame = frame
  try {
    return realResolveOwner(state, ref)
  } finally {
    ownerFrame = previous
    // At this pinned source only nestedRepoTargetId filters this owner's candidate array.
    expect(frame.filters).toBeLessThanOrEqual(1)
  }
})
const realFindDetected = ownerIndex.findIndexedDetectedWorktrees
vi.spyOn(ownerIndex, 'findIndexedDetectedWorktrees').mockImplementation((catalog, id, host) => {
  const rows = realFindDetected(catalog, id, host)
  if (
    ownerFrame &&
    host === undefined &&
    id === ownerFrame.ref.workspaceId &&
    catalog === selectDetectedWorktreesByRepo(ownerFrame.state)
  ) {
    ownerFrame.arrays.add(rows)
  }
  if (!filterDescriptors.has(rows)) {
    filterDescriptors.set(rows, Object.getOwnPropertyDescriptor(rows, 'filter'))
    Object.defineProperty(rows, 'filter', {
      configurable: true,
      value(
        this: typeof rows,
        predicate: (
          row: (typeof rows)[number],
          index: number,
          array: (typeof rows)[number][]
        ) => unknown,
        thisArg?: unknown
      ) {
        const frame = ownerFrame
        const eligible = !!frame?.arrays.has(this)
        if (eligible && frame) {
          frame.filters++
          incomingFilterWork.nestedFilters++
        }
        return Array.prototype.filter.call(
          this,
          function (
            this: unknown,
            row: (typeof rows)[number],
            index: number,
            array: (typeof rows)[number][]
          ) {
            const previous = nestedCandidate
            nestedCandidate =
              eligible && frame?.filters === 1 && meteredDetectedRows.has(row) ? row : undefined
            if (nestedCandidate) {
              incomingFilterWork.nestedVisits++
            }
            try {
              return predicate.call(this, row, index, array)
            } finally {
              nestedCandidate = previous
            }
          },
          thisArg
        )
      }
    })
  }
  return rows
})

export function restoreIncomingFilterArrays() {
  for (const [array, descriptor] of filterDescriptors) {
    if (descriptor) {
      Object.defineProperty(array, 'filter', descriptor)
    } else {
      Reflect.deleteProperty(array, 'filter')
    }
  }
  filterDescriptors.clear()
}

export class IncomingOwnerReadMeter {
  operations = 0
  rawOperations = 0
  nestedFilterExcluded = 0

  row<T extends object, K extends keyof T>(row: T, key: K, category?: 'nested'): T {
    const value = row[key]
    if (category === 'nested' && key === 'runtimeOwnerEnvironmentId') {
      meteredDetectedRows.add(row)
    }
    Object.defineProperty(row, key, {
      enumerable: true,
      get: () => {
        this.rawOperations++
        if (
          category === 'nested' &&
          key === 'runtimeOwnerEnvironmentId' &&
          nestedCandidate === row
        ) {
          this.nestedFilterExcluded++
        } else {
          this.operations++
        }
        return value
      }
    })
    return row
  }

  reset() {
    this.operations = this.rawOperations = this.nestedFilterExcluded = 0
    incomingFilterWork.nestedVisits = incomingFilterWork.nestedFilters = 0
  }

  snapshot() {
    return {
      operations: this.operations,
      rawOperations: this.rawOperations,
      excludedOperations: this.nestedFilterExcluded,
      nestedFilterExcluded: this.nestedFilterExcluded,
      incomingNestedFilterVisits: incomingFilterWork.nestedVisits,
      incomingNestedFilters: incomingFilterWork.nestedFilters
    }
  }
}

export function assertIncomingOwnerFilterBoundaries(
  reads: IncomingOwnerReadMeter,
  state: AppState,
  known: ReturnType<typeof worktreeFixture>,
  ws: string
) {
  const ref = { workspaceId: ws, hostId: 'runtime:owner-a' as const }
  const boundaries: Record<string, ReturnType<typeof reads.snapshot>> = {}
  reads.reset()
  expect(owners.resolveOwner({ ...state, worktreesByRepo: { repo: [known] } }, ref)).toMatchObject({
    kind: 'resolved',
    owner: { at: 'ssh:ssh-1' }
  })
  expect(reads.nestedFilterExcluded).toBe(0)
  expect(incomingFilterWork.nestedFilters).toBe(0)
  boundaries.knownPhysical = reads.snapshot()
  const empty = { ...state, detectedWorktreesByRepo: {}, worktreesByRepo: {} }
  reads.reset()
  expect(owners.resolveOwner(empty, ref)).toMatchObject({
    kind: 'resolved',
    owner: { at: 'local' }
  })
  expect(reads.nestedFilterExcluded).toBe(0)
  expect(incomingFilterWork.nestedVisits).toBe(0)
  boundaries.empty = reads.snapshot()
  reads.reset()
  expect(owners.resolveOwner({ ...empty, repos: [] }, { workspaceId: 'missing' })).toEqual({
    kind: 'missing'
  })
  expect(reads.nestedFilterExcluded).toBe(0)
  expect(incomingFilterWork.nestedFilters).toBe(0)
  boundaries.missing = reads.snapshot()
  const rivals = (['ssh:ssh-1', 'ssh:ssh-2'] as const).map((hostId) =>
    reads.row(
      detectedListingFixture([
        worktreeFixture(ws, '/rival', { hostId, runtimeOwnerEnvironmentId: 'owner-a' })
      ]).worktrees[0]!,
      'runtimeOwnerEnvironmentId',
      'nested'
    )
  )
  const ambiguous = {
    ...empty,
    detectedWorktreesByRepo: { repo: { ...detectedListingFixture([]), worktrees: rivals } }
  }
  reads.reset()
  expect(owners.resolveOwner(ambiguous, ref)).toEqual({ kind: 'ambiguous' })
  expect(reads.nestedFilterExcluded).toBe(2)
  expect(incomingFilterWork.nestedVisits).toBe(2)
  expect(reads.rawOperations).toBe(reads.operations + reads.nestedFilterExcluded)
  boundaries.ambiguous = reads.snapshot()
  const actual = ownerIndex.findIndexedDetectedWorktrees(ambiguous.detectedWorktreesByRepo, ws)
  expect(ownerIndex.findIndexedDetectedWorktrees(ambiguous.detectedWorktreesByRepo, ws)).toBe(
    actual
  )
  expect(Object.getOwnPropertyDescriptor(actual, 'filter')?.enumerable).toBe(false)
  const receiver = {}
  reads.reset()
  expect(
    actual.filter(function (this: typeof receiver, row, index, array) {
      expect(this).toBe(receiver)
      expect(array).toBe(actual)
      expect(row).toBe(rivals[index])
      return row.runtimeOwnerEnvironmentId === 'owner-a'
    }, receiver)
  ).toEqual(rivals)
  expect(reads.rawOperations).toBe(2)
  expect(reads.operations).toBe(2)
  expect(reads.nestedFilterExcluded).toBe(0)
  expect(incomingFilterWork.nestedVisits).toBe(0)
  boundaries.outsideCallback = reads.snapshot()
  restoreIncomingFilterArrays()
  expect(Object.getOwnPropertyDescriptor(actual, 'filter')).toBeUndefined()
  return boundaries
}
