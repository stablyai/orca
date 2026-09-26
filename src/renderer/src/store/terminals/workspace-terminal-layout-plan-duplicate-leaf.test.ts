import { describe, expect, it } from 'vitest'
import { buildWorkspaceTerminalLayoutPlan } from './workspace-terminal-layout-plan'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

const WORKTREE_ID = 'wt-1'
// Ids and shapes copied verbatim from the STA-7961 orca-data.json excerpt.
const SHARED_LEAF_ID = '10cb5648-8a54-41c0-a6a4-ef0028d93599'
const SHARED_PTY_ID = 'wt-1@@289ed0f2'
const SPLIT_TAB_ID = 'eba00a9a-17df-4152-8258-42381b48890a'
const SINGLE_TAB_ID = '881a9ee2-7143-46c8-98ac-8ffbb9cf4b2c'

function tab(id: string, sortOrder: number): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'OpenCode',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 1_789_867_969_623 + sortOrder
  }
}

/** The persisted pair from the report: a nested split and a single leaf, same leaf id and pty. */
function duplicateLeafSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    activeTabId: SINGLE_TAB_ID,
    tabsByWorktree: { [WORKTREE_ID]: [tab(SPLIT_TAB_ID, 0), tab(SINGLE_TAB_ID, 1)] },
    terminalLayoutsByTabId: {
      [SPLIT_TAB_ID]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'df8913c9-fd8a-420a-a7d6-17daf0ed30f0' },
            second: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: SHARED_LEAF_ID },
              second: { type: 'leaf', leafId: '08d0d524-0d46-410b-ba08-b43c97a2b4e4' }
            }
          },
          second: { type: 'leaf', leafId: '96cdf7ea-9c83-4ba5-a41b-c425955e6606' }
        },
        activeLeafId: SHARED_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          'df8913c9-fd8a-420a-a7d6-17daf0ed30f0': 'wt-1@@eaff6e99',
          '96cdf7ea-9c83-4ba5-a41b-c425955e6606': 'wt-1@@e905e74a',
          [SHARED_LEAF_ID]: SHARED_PTY_ID,
          '08d0d524-0d46-410b-ba08-b43c97a2b4e4': 'wt-1@@8123ec24'
        }
      },
      [SINGLE_TAB_ID]: {
        root: { type: 'leaf', leafId: SHARED_LEAF_ID },
        activeLeafId: SHARED_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SHARED_LEAF_ID]: SHARED_PTY_ID }
      }
    }
  }
}

describe('workspace terminal layout hydration (STA-7961)', () => {
  it('binds a persisted leaf id to exactly one tab', () => {
    const session = duplicateLeafSession()
    const tabs = session.tabsByWorktree[WORKTREE_ID] ?? []

    const plan = buildWorkspaceTerminalLayoutPlan({
      ownershipTransfersByTabId: new Map(),
      ownershipTransferTabIds: null,
      releasedPtyIdsByTabId: new Map(),
      session,
      tabById: new Map(tabs.map((row) => [row.id, row])),
      validTabIds: new Set(tabs.map((row) => row.id))
    })

    const tabsBindingSharedLeaf = Object.entries(plan.layoutsByTabId)
      .filter(([, layout]) => SHARED_LEAF_ID in (layout.ptyIdsByLeafId ?? {}))
      .map(([tabId]) => tabId)
    expect(tabsBindingSharedLeaf).toHaveLength(1)
  })

  it('hands the shared pty to exactly one tab', () => {
    const session = duplicateLeafSession()
    const tabs = session.tabsByWorktree[WORKTREE_ID] ?? []

    const plan = buildWorkspaceTerminalLayoutPlan({
      ownershipTransfersByTabId: new Map(),
      ownershipTransferTabIds: null,
      releasedPtyIdsByTabId: new Map(),
      session,
      tabById: new Map(tabs.map((row) => [row.id, row])),
      validTabIds: new Set(tabs.map((row) => row.id))
    })

    const tabsBindingSharedPty = Object.entries(plan.layoutsByTabId)
      .filter(([, layout]) => Object.values(layout.ptyIdsByLeafId ?? {}).includes(SHARED_PTY_ID))
      .map(([tabId]) => tabId)
    expect(tabsBindingSharedPty).toHaveLength(1)
  })
})
