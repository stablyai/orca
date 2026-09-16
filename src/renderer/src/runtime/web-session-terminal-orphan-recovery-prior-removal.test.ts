import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeHostTerminalSnapshot } from './__fixtures__/web-session-terminal-host-finalization'
import {
  ENVIRONMENT_ID,
  listResult,
  makeSnapshot,
  makeState,
  pendingSurface
} from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import { clearWebSessionTerminalOrphanRecoveryForTests } from './web-session-terminal-orphan-recovery'
import { mergeAdoptionResponse } from './web-session-terminal-orphan-recovery-adoption'
import { resolveTerminalOrphanInventory } from './web-session-terminal-orphan-recovery-inventory'
import {
  prepareTerminalOrphanRecovery,
  surfaceKey
} from './web-session-terminal-orphan-recovery-surface'

describe('post-adoption reconciliation of previously removed surfaces', () => {
  beforeEach(clearWebSessionTerminalOrphanRecoveryForTests)

  it.each(['exact-retirement', 'confirmed-inventory-absence'])(
    'preserves a newer host-published pending row after %s removed the old surface',
    async (evidence) => {
      const worktree = 'folder:post-adoption-prior-removal'
      const leaves = [
        { leafId: 'leaf-claim', handle: 'term-claim' },
        { leafId: 'leaf-old', handle: 'term-old' }
      ]
      const state = makeState(worktree, leaves)
      const snapshot = finalizeHostTerminalSnapshot({
        ...makeSnapshot(worktree, 'renderer:host:client-navigation', leaves),
        tabs: [pendingSurface('host-tab', 'leaf-claim', 'pty-claim')],
        retiredTerminalSurfaces:
          evidence === 'exact-retirement'
            ? [
                {
                  parentTabId: 'host-tab',
                  leafId: 'leaf-old',
                  ptyId: 'pty-old',
                  terminal: 'term-old',
                  incarnationId: 'inc-old'
                }
              ]
            : []
      })
      const call = vi.fn(async () => ({
        id: 'inventory',
        ok: true as const,
        _meta: { runtimeId: 'host-runtime' },
        result: listResult(worktree, [
          {
            handle: 'term-claim',
            ptyId: 'pty-claim',
            incarnationId: 'inc-claim',
            orphaned: true
          }
        ])
      }))
      const inventoryArgs = {
        candidates: prepareTerminalOrphanRecovery(state, snapshot, ENVIRONMENT_ID).candidates,
        snapshot,
        environmentId: ENVIRONMENT_ID,
        call,
        isCurrent: () => true
      }
      const oldSurfaceKey = surfaceKey('host-tab', 'leaf-old')
      if (evidence === 'confirmed-inventory-absence') {
        const first = await resolveTerminalOrphanInventory(inventoryArgs)
        expect(first?.removed.size).toBe(0)
        expect(first?.retained.map((surface) => surface.surfaceKey)).toEqual([oldSurfaceKey])
      }
      const inventory = await resolveTerminalOrphanInventory(inventoryArgs)
      expect(inventory?.removed).toEqual(new Set([oldSurfaceKey]))
      expect(inventory?.retained).toEqual([])
      expect(inventory?.claims).toEqual([
        {
          terminal: 'term-claim',
          ptyId: 'pty-claim',
          incarnationId: 'inc-claim',
          tabId: 'host-tab',
          leafId: 'leaf-claim'
        }
      ])
      expect(call).toHaveBeenCalledTimes(evidence === 'exact-retirement' ? 1 : 2)

      const pending = pendingSurface('host-tab', 'leaf-old', 'pty-new')
      const projected = finalizeHostTerminalSnapshot({
        ...snapshot,
        snapshotVersion: snapshot.snapshotVersion + 1,
        tabs: [pendingSurface('host-tab', 'leaf-claim', 'pty-claim', 'term-claim'), pending]
      })
      expect(projected.retiredTerminalSurfaces).toEqual([])
      expect(projected.tabs[1]).toEqual(pending)

      const merged = mergeAdoptionResponse(projected, inventory!.retained, [], inventory!.removed)
      expect(merged).toBe(projected)
      expect(merged.tabs).toEqual([projected.tabs[0], pending])
      expect(inventory?.removed).toEqual(new Set([oldSurfaceKey]))
    }
  )
})
