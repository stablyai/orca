import { describe, expect, it } from 'vitest'
import type { CloudWorkspaceIdentity } from './cloud-workspace-identity'
import {
  OWNER_CHANGE_NOTICE_MAX_AGE_MS,
  markNewOwnerNoticeSeen,
  newOwnerWorkspaces
} from './owner-change-notices-store'

const DAY = 24 * 60 * 60_000
const NOW = 400 * DAY

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value)
  }
}

function identity(overrides: Partial<CloudWorkspaceIdentity>): CloudWorkspaceIdentity {
  return {
    number: 7,
    link: null,
    title: 'Checkout retries',
    ownerUserId: 'user_ada',
    createdAt: NOW - 10 * DAY,
    ownershipTransferredAt: NOW - DAY,
    ...overrides
  }
}

describe('newOwnerWorkspaces (OWNER-TRANSFER)', () => {
  it('names a workspace handed to you, once', () => {
    const storage = memoryStorage()
    const rows = new Map([['sbx_a', identity({})]])
    expect(newOwnerWorkspaces(rows, 'user_ada', NOW, storage)).toEqual([
      { sandboxId: 'sbx_a', transferredAt: NOW - DAY, title: 'Checkout retries' }
    ])
    markNewOwnerNoticeSeen(storage, 'sbx_a', NOW - DAY)
    expect(newOwnerWorkspaces(rows, 'user_ada', NOW, storage)).toEqual([])
  })

  it('shows again for a later hand-off of the same workspace', () => {
    const storage = memoryStorage()
    markNewOwnerNoticeSeen(storage, 'sbx_a', NOW - 5 * DAY)
    const rows = new Map([['sbx_a', identity({ ownershipTransferredAt: NOW - DAY })]])
    expect(newOwnerWorkspaces(rows, 'user_ada', NOW, storage)).toHaveLength(1)
  })

  it('leaves out workspaces you do not own, ones never handed over, and old hand-offs', () => {
    const rows = new Map([
      ['sbx_theirs', identity({ ownerUserId: 'user_grace' })],
      ['sbx_never', identity({ ownershipTransferredAt: null })],
      ['sbx_old', identity({ ownershipTransferredAt: NOW - OWNER_CHANGE_NOTICE_MAX_AGE_MS })]
    ])
    expect(newOwnerWorkspaces(rows, 'user_ada', NOW, memoryStorage())).toEqual([])
    expect(newOwnerWorkspaces(rows, null, NOW, memoryStorage())).toEqual([])
  })

  it('leaves out a workspace made from a handed-over one (it inherits the mark)', () => {
    const rows = new Map([
      ['sbx_child', identity({ createdAt: NOW - DAY / 2, ownershipTransferredAt: NOW - DAY })]
    ])
    expect(newOwnerWorkspaces(rows, 'user_ada', NOW, memoryStorage())).toEqual([])
  })

  it('still shows when storage cannot be read', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('denied')
      }
    }
    expect(
      newOwnerWorkspaces(new Map([['sbx_a', identity({})]]), 'user_ada', NOW, broken)
    ).toHaveLength(1)
  })
})
