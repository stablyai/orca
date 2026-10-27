import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENVIRONMENT_ID,
  listResult,
  makeSnapshot,
  makeState
} from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'

/** Prune only after two authoritative absences; incomplete scope holds bindings. omittedHostIds peers are disclosure, not incomplete host coverage (#18595). */
const LEAVES = [{ leafId: 'leaf-1', handle: 'term-ghost' }]

// Fixture defaults undefined scope; delete the key to actually test absence.
async function recoverTwice(worktree: string, hostScope: Record<string, unknown> | null) {
  const state = makeState(worktree, LEAVES)
  const call = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'terminal.list') {
      const listed = listResult(worktree, [])
      if (hostScope === null) {
        delete (listed as { hostScope?: unknown }).hostScope
      } else {
        listed.hostScope = hostScope as never
      }
      return { ok: true as const, result: listed }
    }
    return { ok: false as const, error: { code: 'conflict', message: 'unexpected' } }
  })
  await recoverWebSessionTerminalOrphansBeforeApply(
    state,
    makeSnapshot(worktree, 'epoch-1', LEAVES),
    ENVIRONMENT_ID,
    { call: call as never }
  )
  return recoverWebSessionTerminalOrphansBeforeApply(
    state,
    makeSnapshot(worktree, 'epoch-2', LEAVES),
    ENVIRONMENT_ID,
    { call: call as never }
  )
}

describe('orphan recovery reads the host scope as coverage owed, not as disclosure', () => {
  beforeEach(() => {
    clearWebSessionTerminalOrphanRecoveryForTests()
  })

  it('prunes a twice-absent binding when the only omission is a peer runtime', async () => {
    const settled = await recoverTwice('repo::peer-disclosed', {
      hostIds: ['local'],
      omittedHostIds: ['runtime:env-peer']
    })

    expect(settled?.tabs).toEqual([])
  })

  it('retains the binding when an SSH host this runtime does query went unanswered', async () => {
    const settled = await recoverTwice('repo::ssh-gap', {
      hostIds: ['local'],
      omittedHostIds: ['ssh:box-1']
    })

    expect(settled?.tabs).toEqual([
      expect.objectContaining({ leafId: 'leaf-1', terminal: 'term-ghost' })
    ])
  })

  it('retains the binding when the listing covered no host at all', async () => {
    const settled = await recoverTwice('repo::covered-nothing', {
      hostIds: [],
      omittedHostIds: ['local', 'runtime:env-peer']
    })

    expect(settled?.tabs).toEqual([
      expect.objectContaining({ leafId: 'leaf-1', terminal: 'term-ghost' })
    ])
  })

  // Pre-v1.4.187 hosts omit hostScope; no claim cannot prove complete coverage.
  it('retains the binding when the host is too old to publish a scope', async () => {
    const settled = await recoverTwice('repo::no-scope', null)

    expect(settled?.tabs).toEqual([
      expect.objectContaining({ leafId: 'leaf-1', terminal: 'term-ghost' })
    ])
  })
})
