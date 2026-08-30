import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
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

const AGENT_TAB_ID = toWebTerminalSurfaceTabId('host-agent')
const SHELL_TAB_ID = toWebTerminalSurfaceTabId('host-shell')
const EXTRA_TAB_ID = toWebTerminalSurfaceTabId('host-extra')
const FILE_TAB_ID = 'local-file-tab'

const LOCAL_FILE_TAB: Tab = {
  id: FILE_TAB_ID,
  entityId: 'local-file-agents-md',
  groupId: 'host-group-1',
  worktreeId: WT,
  contentType: 'editor',
  label: 'AGENTS.md',
  customLabel: null,
  color: null,
  sortOrder: 2,
  createdAt: NOW + 1,
  isPreview: false,
  isPinned: false
}

function hostSurface(
  parentTabId: string,
  leafId: string,
  isActive: boolean
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: `${parentTabId}::${leafId}`,
    title: parentTabId,
    parentTabId,
    leafId,
    isActive,
    status: 'ready',
    terminal: `terminal-${parentTabId}`
  }
}

const AGENT_SURFACE = hostSurface('host-agent', LEAF_ID, true)
const SHELL_SURFACE = hostSurface('host-shell', SECOND_LEAF_ID, false)
const EXTRA_SURFACE = hostSurface('host-extra', THIRD_LEAF_ID, false)

/** Applies one host snapshot on top of a group whose tab order the client already holds. */
function syncTabOrder(args: {
  currentTabOrder: string[]
  hostSurfaces: RuntimeMobileSessionTabsResult['tabs']
  hostTabOrder?: string[]
  otherHostGroups?: { id: string; tabOrder: string[] }[]
}): string[] | undefined {
  const patch = applyWebSessionTabsSnapshot(
    makeState({
      unifiedTabsByWorktree: { [WT]: [LOCAL_FILE_TAB] },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'host-group-1',
            worktreeId: WT,
            activeTabId: FILE_TAB_ID,
            tabOrder: args.currentTabOrder
          }
        ]
      }
    }),
    makeSnapshot(args.hostSurfaces, {
      activeGroupId: 'host-group-1',
      activeTabId: `host-agent::${LEAF_ID}`,
      ...(args.hostTabOrder
        ? {
            tabGroups: [
              { id: 'host-group-1', activeTabId: 'host-agent', tabOrder: args.hostTabOrder },
              ...(args.otherHostGroups ?? []).map((group) => ({
                id: group.id,
                activeTabId: group.tabOrder[0] ?? null,
                tabOrder: group.tabOrder
              }))
            ]
          }
        : {})
    }),
    ENV,
    NOW
  ) as Partial<WebSessionTabsSyncState>
  return patch.groupsByWorktree?.[WT]?.find((group) => group.id === 'host-group-1')?.tabOrder
}

describe('local file tab order on a remote host', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps a Cmd-clicked file tab where it was opened instead of hoisting it to the front', () => {
    expect(
      syncTabOrder({
        currentTabOrder: [AGENT_TAB_ID, SHELL_TAB_ID, FILE_TAB_ID],
        hostSurfaces: [AGENT_SURFACE, SHELL_SURFACE],
        hostTabOrder: ['host-agent', 'host-shell']
      })
    ).toEqual([AGENT_TAB_ID, SHELL_TAB_ID, FILE_TAB_ID])
  })

  it('keeps a file tab opened between two host tabs in its slot', () => {
    expect(
      syncTabOrder({
        currentTabOrder: [AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID],
        hostSurfaces: [AGENT_SURFACE, SHELL_SURFACE],
        hostTabOrder: ['host-agent', 'host-shell']
      })
    ).toEqual([AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID])
  })

  it('still adopts a host reorder of the host-owned tabs', () => {
    expect(
      syncTabOrder({
        currentTabOrder: [AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID],
        hostSurfaces: [AGENT_SURFACE, SHELL_SURFACE],
        hostTabOrder: ['host-shell', 'host-agent']
      })
    ).toEqual([SHELL_TAB_ID, FILE_TAB_ID, AGENT_TAB_ID])
  })

  it('appends a newly published host tab after the existing order', () => {
    expect(
      syncTabOrder({
        currentTabOrder: [AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID],
        hostSurfaces: [AGENT_SURFACE, SHELL_SURFACE, EXTRA_SURFACE],
        hostTabOrder: ['host-agent', 'host-shell', 'host-extra']
      })
    ).toEqual([AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID, EXTRA_TAB_ID])
  })

  it('does not let a retracted host tab consume a live host tab slot', () => {
    expect(
      syncTabOrder({
        currentTabOrder: [EXTRA_TAB_ID, AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID],
        hostSurfaces: [AGENT_SURFACE, SHELL_SURFACE],
        hostTabOrder: ['host-agent', 'host-shell']
      })
    ).toEqual([AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID])
  })

  it('does not let a host tab that moved to another group pull a live tab past the file tab', () => {
    expect(
      syncTabOrder({
        currentTabOrder: [SHELL_TAB_ID, FILE_TAB_ID, AGENT_TAB_ID],
        hostSurfaces: [AGENT_SURFACE, SHELL_SURFACE],
        hostTabOrder: ['host-agent'],
        otherHostGroups: [{ id: 'host-group-2', tabOrder: ['host-shell'] }]
      })
    ).toEqual([FILE_TAB_ID, AGENT_TAB_ID])
  })

  it('keeps the file tab in place on a host that publishes no tab groups', () => {
    expect(
      syncTabOrder({
        currentTabOrder: [AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID],
        hostSurfaces: [AGENT_SURFACE, SHELL_SURFACE]
      })
    ).toEqual([AGENT_TAB_ID, FILE_TAB_ID, SHELL_TAB_ID])
  })
})
