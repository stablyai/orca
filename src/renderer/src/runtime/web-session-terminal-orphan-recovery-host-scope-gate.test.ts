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

/**
 * The second consumer of `hostScopeCensusIsComplete`. Pruning here needs two consecutive
 * authoritative inventories that omit the surface, so an incomplete census must hold the binding
 * open indefinitely — and a peer runtime named in `omittedHostIds` must not be read as one, or
 * the ghost binding is retained forever (#18595).
 */
const LEAVES = [{ leafId: 'leaf-1', handle: 'term-ghost' }]

/**
 * `listResult` substitutes a default scope when handed `undefined`, so the absent-scope case has
 * to drop the key itself — passing `undefined` through the fixture silently tests the default.
 */
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

  // Why: a host predating `hostScope` (v1.4.187) cannot say what it covered, and absence of the
  // claim is never the claim.
  it('retains the binding when the host is too old to publish a scope', async () => {
    const settled = await recoverTwice('repo::no-scope', null)

    expect(settled?.tabs).toEqual([
      expect.objectContaining({ leafId: 'leaf-1', terminal: 'term-ghost' })
    ])
  })
})
