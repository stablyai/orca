import { describe, expect, it } from 'vitest'
import type { TabGroup } from '../../../../shared/tab-types'
import { buildMirroredHostGroups } from './layout-groups'

// Why: #5435's rule, applied one level down. A host group's `activeTabId` is a report of what the
// host has focused — on an agent-running host it follows the working session — so it must not
// outrank the tab this client is showing in that group. Only a client-owned intent may.

const WT = 'repo::/worktree'
const ENV = 'web-env-1'
const NOW = 1_700_000_000_000

const GROUP_A = 'host-group-a'
const GROUP_B = 'host-group-b'
const VISIBLE_TAB = 'web-terminal-visible'
const CLIENT_TAB_IN_B = 'web-terminal-client-choice'
const HOST_ACTIVE_TAB_IN_B = 'web-terminal-host-choice'

function group(id: string, activeTabId: string | null, tabOrder: string[]): TabGroup {
  return { id, worktreeId: WT, activeTabId, tabOrder, recentTabIds: [...tabOrder] }
}

/** Two groups, as a split workspace has: the client is looking at group A, and group B shows a tab
 *  of its own while the host reports a different one as active. */
function buildSplit(options: { honorSnapshotActiveFocus: boolean }): TabGroup[] | null {
  return buildMirroredHostGroups({
    currentGroups: [
      group(GROUP_A, VISIBLE_TAB, [VISIBLE_TAB]),
      group(GROUP_B, CLIENT_TAB_IN_B, [CLIENT_TAB_IN_B, HOST_ACTIVE_TAB_IN_B])
    ],
    hostGroups: [
      { id: GROUP_A, activeTabId: 'host-visible', tabOrder: ['host-visible'] },
      {
        id: GROUP_B,
        activeTabId: 'host-choice',
        tabOrder: ['host-client-choice', 'host-choice']
      }
    ],
    hostToLocalTabId: new Map([
      ['host-visible', VISIBLE_TAB],
      ['host-client-choice', CLIENT_TAB_IN_B],
      ['host-choice', HOST_ACTIVE_TAB_IN_B]
    ]),
    mirroredUnifiedIds: new Set([VISIBLE_TAB, CLIENT_TAB_IN_B, HOST_ACTIVE_TAB_IN_B]),
    // The client is looking at group A, so nothing selects a tab inside group B.
    nextActiveUnifiedTabId: VISIBLE_TAB,
    now: NOW,
    validUnifiedTabIds: new Set([VISIBLE_TAB, CLIENT_TAB_IN_B, HOST_ACTIVE_TAB_IN_B]),
    environmentId: ENV,
    worktreeId: WT,
    clientGroupIdByLocalTabId: new Map(),
    honorSnapshotActiveFocus: options.honorSnapshotActiveFocus
  })
}

describe('buildMirroredHostGroups — active tab ranking', () => {
  it('keeps the tab the client is showing in a group the host reports differently', () => {
    const groups = buildSplit({ honorSnapshotActiveFocus: false })

    expect(groups?.find((entry) => entry.id === GROUP_A)?.activeTabId).toBe(VISIBLE_TAB)
    expect(groups?.find((entry) => entry.id === GROUP_B)?.activeTabId).toBe(CLIENT_TAB_IN_B)
  })

  it('follows the host active tab when the frame carries navigation intent', () => {
    const groups = buildSplit({ honorSnapshotActiveFocus: true })

    expect(groups?.find((entry) => entry.id === GROUP_B)?.activeTabId).toBe(HOST_ACTIVE_TAB_IN_B)
  })

  it('adopts the host active tab for a group this client has never shown', () => {
    const groups = buildMirroredHostGroups({
      currentGroups: [group(GROUP_A, VISIBLE_TAB, [VISIBLE_TAB])],
      hostGroups: [
        { id: GROUP_A, activeTabId: 'host-visible', tabOrder: ['host-visible'] },
        { id: GROUP_B, activeTabId: 'host-choice', tabOrder: ['host-choice'] }
      ],
      hostToLocalTabId: new Map([
        ['host-visible', VISIBLE_TAB],
        ['host-choice', HOST_ACTIVE_TAB_IN_B]
      ]),
      mirroredUnifiedIds: new Set([VISIBLE_TAB, HOST_ACTIVE_TAB_IN_B]),
      nextActiveUnifiedTabId: VISIBLE_TAB,
      now: NOW,
      validUnifiedTabIds: new Set([VISIBLE_TAB, HOST_ACTIVE_TAB_IN_B]),
      environmentId: ENV,
      worktreeId: WT,
      clientGroupIdByLocalTabId: new Map(),
      honorSnapshotActiveFocus: false
    })

    expect(groups?.find((entry) => entry.id === GROUP_B)?.activeTabId).toBe(HOST_ACTIVE_TAB_IN_B)
  })
})
