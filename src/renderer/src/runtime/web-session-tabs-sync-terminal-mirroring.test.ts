import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'

import { finalizeHostTerminalSnapshot } from './__fixtures__/web-session-terminal-host-finalization'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it.each([
    { name: 'no retirement field', retiredHandle: null },
    { name: 'another handle retired', retiredHandle: 'terminal-other' },
    { name: 'the prior handle retired', retiredHandle: 'terminal-1' }
  ])('retains a known pending binding after host finalization ($name)', ({ retiredHandle }) => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const priorPtyId = 'remote:web-env-1@@terminal-1'
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: priorPtyId,
      worktreeId: WT,
      title: 'host shell',
      defaultTitle: 'host shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }

    const state = makeState({
      tabsByWorktree: { [WT]: [existingTab] },
      ptyIdsByTabId: { [mirroredId]: [priorPtyId] },
      terminalLayoutsByTabId: {
        [mirroredId]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: priorPtyId }
        }
      }
    })
    const snapshot = finalizeHostTerminalSnapshot(
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'reconnecting shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'pending-handle',
            terminal: null
          }
        ],
        {
          retiredTerminalSurfaces: retiredHandle
            ? [
                {
                  parentTabId: 'host-tab-1',
                  leafId: LEAF_ID,
                  terminal: retiredHandle,
                  ptyId: 'retired-pty',
                  incarnationId: 'retired-incarnation'
                }
              ]
            : undefined
        }
      )
    )
    expect(snapshot.retiredTerminalSurfaces).toEqual(retiredHandle ? [] : undefined)
    expect(snapshot.tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })

    const patch = applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW + 1)
    const nextState = { ...state, ...patch }

    expect(nextState.tabsByWorktree[WT]?.[0]).toMatchObject({
      id: mirroredId,
      ptyId: priorPtyId,
      title: 'reconnecting shell'
    })
    expect(nextState.terminalLayoutsByTabId[mirroredId]?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: priorPtyId
    })
    expect(nextState.ptyIdsByTabId[mirroredId]).toEqual([priorPtyId])
  })
})
