import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  allocateServiceSlot,
  getWorktreeServicesRecord,
  listWorktreeServicesRecords,
  removeWorktreeServicesRecord,
  upsertWorktreeServicesRecord
} from './worktree-services-store'
import type { WorktreeServicesRecord } from './worktree-services'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-svc-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(worktreeId: string, slot: number): WorktreeServicesRecord {
  return {
    worktreeId,
    repoId: 'repo-1',
    slot,
    slug: `wt-s${slot}`,
    serviceIds: ['db'],
    env: { ORCA_SERVICE_SLOT: String(slot) },
    status: 'ready',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z'
  }
}

describe('worktree services store', () => {
  it('starts empty and allocates slot 0', () => {
    expect(listWorktreeServicesRecords(dir)).toEqual([])
    expect(allocateServiceSlot(dir)).toBe(0)
  })

  it('round-trips records and fills slot gaps', () => {
    upsertWorktreeServicesRecord(dir, record('wt-a', 0))
    upsertWorktreeServicesRecord(dir, record('wt-b', 2))
    expect(allocateServiceSlot(dir)).toBe(1)
    expect(getWorktreeServicesRecord(dir, 'wt-a')?.slot).toBe(0)
  })

  it('remove frees the slot and returns the removed record', () => {
    upsertWorktreeServicesRecord(dir, record('wt-a', 0))
    expect(removeWorktreeServicesRecord(dir, 'wt-a')?.worktreeId).toBe('wt-a')
    expect(allocateServiceSlot(dir)).toBe(0)
    expect(removeWorktreeServicesRecord(dir, 'wt-a')).toBeNull()
  })

  it('upsert replaces the record for the same worktreeId', () => {
    upsertWorktreeServicesRecord(dir, record('wt-a', 0))
    upsertWorktreeServicesRecord(dir, { ...record('wt-a', 0), status: 'create_failed' })
    expect(listWorktreeServicesRecords(dir)).toHaveLength(1)
    expect(getWorktreeServicesRecord(dir, 'wt-a')?.status).toBe('create_failed')
  })
})
