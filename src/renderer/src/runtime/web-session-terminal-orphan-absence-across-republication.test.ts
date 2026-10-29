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

const LEAVES = [{ leafId: 'leaf-1', handle: 'term-ghost' }]

describe('inventory absence confirmed across host republications', () => {
  beforeEach(() => {
    clearWebSessionTerminalOrphanRecoveryForTests()
  })

  it('prunes a binding two fresh-liveness inventories omit even when the host re-published between them', async () => {
    const worktree = 'repo::ghost-across-republication'
    const state = makeState(worktree, LEAVES)
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        return { ok: true as const, result: listResult(worktree, []) }
      }
      return { ok: false as const, error: { code: 'conflict', message: 'unexpected' } }
    })

    // Every host publication mints a new epoch; the surface identity being confirmed absent does not change.
    const first = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      makeSnapshot(worktree, 'epoch-1', LEAVES),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    expect(first?.tabs).toEqual([
      expect.objectContaining({ leafId: 'leaf-1', terminal: 'term-ghost' })
    ])

    const second = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      makeSnapshot(worktree, 'epoch-2', LEAVES),
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(second?.tabs).toEqual([])
  })

  it('restarts confirmation when the host lists the surface again', async () => {
    const worktree = 'repo::ghost-relisted'
    const state = makeState(worktree, LEAVES)
    let listedTerminals: readonly Record<string, unknown>[] = []
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        return { ok: true as const, result: listResult(worktree, listedTerminals) }
      }
      return { ok: false as const, error: { code: 'conflict', message: 'unexpected' } }
    })

    await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      makeSnapshot(worktree, 'epoch-1', LEAVES),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    listedTerminals = [{ handle: 'term-ghost', ptyId: 'pty-1', incarnationId: 'inc-1' }]
    await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      makeSnapshot(worktree, 'epoch-2', LEAVES),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    listedTerminals = []

    const third = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      makeSnapshot(worktree, 'epoch-3', LEAVES),
      ENVIRONMENT_ID,
      { call: call as never }
    )

    // A live sighting resets the count; one later absence is not two.
    expect(third?.tabs).toEqual([
      expect.objectContaining({ leafId: 'leaf-1', terminal: 'term-ghost' })
    ])
  })
})
