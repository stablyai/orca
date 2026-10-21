// The activation gate's live-terminal adoption in a layout-owner build: main places every live
// terminal no pane shows (placeUnshownLiveTerminals) and its frames draw it, so the window makes no
// tab, pane or binding of its own and only reads that main's frames hold the terminal. The frames
// drawing main's tab is covered in worktree-agent-live-surface-adoption-cli-tab.test.ts and
// worktree-agent-live-surface-adoption-layout-owner.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishedTab } from '../../../shared/workspace-layout/workspace-layout-published'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import { runWorktreeAgentActivationGate } from './worktree-agent-activation-gate'
import {
  type GateTestStore,
  listed,
  LIVE_LEAF_ID,
  seedExistingSurface,
  SIBLING_LEAF_ID,
  sleepingRecord,
  testDeps,
  UNOWNED,
  WORKTREE_ID
} from './worktree-agent-activation-gate.test-fixture'
import type { LiveTerminalSurfaceOwner } from './worktree-live-terminal-surface-owners'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const LIVE_PTY = `${WORKTREE_ID}@@live-pty`
const MAIN_TAB = 'tab-main'

type HeldPane = { worktreeId?: string; tabId: string; leafId: string; ptyId: string }

/** Main's frames hold these terminal panes, drawn by the window yet or not. */
function mainHolds(...panes: HeldPane[]): void {
  const held = (worktreeId: string) =>
    panes.filter((pane) => (pane.worktreeId ?? WORKTREE_ID) === worktreeId)
  provideLayoutFrameTerminalPanes({
    holdsTerminalPane: (worktreeId, pane) =>
      held(worktreeId).some(
        (h) => h.tabId === pane.tabId && h.leafId === pane.leafId && h.ptyId === pane.ptyId
      ),
    terminalTab: (worktreeId, tabId): PublishedTab | undefined => {
      const tabPanes = held(worktreeId).filter((pane) => pane.tabId === tabId)
      return tabPanes.length === 0
        ? undefined
        : {
            id: tabId,
            kind: 'terminal',
            entityId: tabId,
            executionHostId: 'local',
            createdAt: 1,
            customTitle: null,
            color: null,
            terminal: {
              root: { type: 'leaf', leafId: tabPanes[0]!.leafId },
              panes: tabPanes.map(({ leafId, ptyId }) => ({ leafId, ptyId }))
            }
          }
    }
  })
}

/** The pane main placed a terminal in, as the host's census records it. */
function placed(ptyId: string, tabId = MAIN_TAB, leafId = LIVE_LEAF_ID): LiveTerminalSurfaceOwner {
  return { paneKey: `${tabId}:${leafId}`, ptyId, tabId }
}

/** The window wrote nothing of its own: main's frames are what show the terminal. */
function expectNoWindowWrite(store: GateTestStore): void {
  expect(store.createTab).not.toHaveBeenCalled()
  expect(store.setTabLayout).not.toHaveBeenCalled()
  expect(store.updateTabPtyId).not.toHaveBeenCalled()
  expect(store.replaceTerminalLayoutPanePtyId).not.toHaveBeenCalled()
}

beforeEach(() => {
  mainHolds()
})

describe('worktree agent activation gate, layout-owner build', () => {
  it('uses immediately ready development restore inventory', async () => {
    mainHolds({ tabId: MAIN_TAB, leafId: LIVE_LEAF_ID, ptyId: LIVE_PTY })
    const { deps, resume } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, { unowned: true, recorded: placed(LIVE_PTY) }]])
    })
    const awaitReady = vi.fn(async () => true)

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, { ...deps, awaitReady })
    ).resolves.toBe('adopted')

    expect(awaitReady).toHaveBeenCalledOnce()
    expectNoWindowWrite(deps.getState())
    expect(resume).not.toHaveBeenCalled()
  })

  it('waits for packaged restore hydration before reading daemon inventory', async () => {
    mainHolds({ tabId: MAIN_TAB, leafId: LIVE_LEAF_ID, ptyId: LIVE_PTY })
    const { deps, resume } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, { unowned: true, recorded: placed(LIVE_PTY) }]])
    })
    let releaseReady!: (ready: boolean) => void
    const awaitReady = vi.fn(() => new Promise<boolean>((resolve) => (releaseReady = resolve)))

    const activation = runWorktreeAgentActivationGate(WORKTREE_ID, { ...deps, awaitReady })
    await vi.waitFor(() => expect(awaitReady).toHaveBeenCalledOnce())
    expect(deps.listSessions).not.toHaveBeenCalled()

    releaseReady(true)
    await expect(activation).resolves.toBe('adopted')
    expect(deps.listSessions).toHaveBeenCalledOnce()
    expectNoWindowWrite(deps.getState())
    expect(resume).not.toHaveBeenCalled()
  })

  it('adopts the live daemon PTY main placed before activation can resume another agent', async () => {
    mainHolds({ tabId: MAIN_TAB, leafId: LIVE_LEAF_ID, ptyId: LIVE_PTY })
    const { deps, resume } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, { unowned: true, recorded: placed(LIVE_PTY) }]])
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expectNoWindowWrite(deps.getState())
    expect(resume).not.toHaveBeenCalled()
  })

  it('never surfaces a PTY its host is killing', async () => {
    const closingPtyId = `${WORKTREE_ID}@@closed-pane`
    const keptPtyId = `${WORKTREE_ID}@@kept-pane`
    mainHolds({ tabId: MAIN_TAB, leafId: LIVE_LEAF_ID, ptyId: keptPtyId })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps } = testDeps({
      sessions: [
        { ...listed(closingPtyId), title: 'zsh', agentOwnership: 'absent', exiting: true },
        { ...listed(keptPtyId), title: 'zsh', agentOwnership: 'absent' }
      ],
      surfaceOwners: new Map([
        [closingPtyId, UNOWNED],
        [keptPtyId, { unowned: true, recorded: placed(keptPtyId) }]
      ]),
      resumeCount: 0
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expectNoWindowWrite(deps.getState())
    // The closing PTY is not even a candidate: a candidate main does not hold is reported declined.
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('leaves an unowned PTY to the recorded pane this renderer still holds, bound by main', async () => {
    const recorded = placed(LIVE_PTY, 'tab-live')
    mainHolds({ tabId: 'tab-live', leafId: LIVE_LEAF_ID, ptyId: LIVE_PTY })
    const { deps, resume } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, { unowned: true, recorded }]])
    })
    seedExistingSurface(deps.getState(), { tabId: 'tab-live', leafId: LIVE_LEAF_ID })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    // No second tab: main's frame binds the pane the renderer holds.
    expectNoWindowWrite(deps.getState())
    expect(resume).not.toHaveBeenCalled()
  })

  it.each<[string, (store: GateTestStore) => void]>([
    [
      'the recorded pane now holds another PTY',
      (store) =>
        seedExistingSurface(store, {
          tabId: 'tab-live',
          leafId: LIVE_LEAF_ID,
          boundPtyId: `${WORKTREE_ID}@@other-pty`
        })
    ],
    ['the recorded tab is gone', () => {}],
    [
      'the recorded leaf is no longer in the tab layout',
      (store) => seedExistingSurface(store, { tabId: 'tab-live', leafId: SIBLING_LEAF_ID })
    ],
    [
      'the recorded tab belongs to another worktree',
      (store) =>
        seedExistingSurface(store, {
          tabId: 'tab-live',
          leafId: LIVE_LEAF_ID,
          worktreeId: 'repo::/other-worktree'
        })
    ]
  ])('shows main’s new tab for an unowned PTY when %s', async (_case, seed) => {
    // Main placed the PTY in a new tab of its own and recorded that pane, not the stale one.
    mainHolds({ tabId: MAIN_TAB, leafId: LIVE_LEAF_ID, ptyId: LIVE_PTY })
    const { deps } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, { unowned: true, recorded: placed(LIVE_PTY) }]])
    })
    seed(deps.getState())
    const recordedLayoutBefore = structuredClone(deps.getState().terminalLayoutsByTabId['tab-live'])

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expectNoWindowWrite(deps.getState())
    expect(deps.getState().terminalLayoutsByTabId['tab-live']).toEqual(recordedLayoutBefore)
    expect(deps.getState().ptyIdsByTabId['tab-live']).toBeUndefined()
  })

  it('adopts a daemon PTY main placed for a folder workspace', async () => {
    const folderWorkspaceId = 'folder:plain-workspace'
    const ptyId = `${folderWorkspaceId}@@live-pty`
    mainHolds({ worktreeId: folderWorkspaceId, tabId: MAIN_TAB, leafId: LIVE_LEAF_ID, ptyId })
    const { deps, resume } = testDeps({
      sessions: [listed(ptyId)],
      surfaceOwners: new Map([[ptyId, { unowned: true, recorded: placed(ptyId) }]])
    })

    await expect(runWorktreeAgentActivationGate(folderWorkspaceId, deps)).resolves.toBe('adopted')

    expectNoWindowWrite(deps.getState())
    expect(resume).not.toHaveBeenCalled()
  })

  it('reads the host tab of a surface this renderer never mounted from main’s frames', async () => {
    const hostTabId = '3359f7c8-9bd8-4931-8104-52b6bdbd108d'
    mainHolds({ tabId: hostTabId, leafId: LIVE_LEAF_ID, ptyId: LIVE_PTY })
    const { deps } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, placed(LIVE_PTY, hostTabId)]])
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expectNoWindowWrite(deps.getState())
  })

  it('reports adopted only for the PTYs that actually landed on a surface', async () => {
    const adoptedPtyId = `${WORKTREE_ID}@@orphan-agent`
    const unverifiablePtyId = `${WORKTREE_ID}@@ambiguous-agent`
    mainHolds({ tabId: MAIN_TAB, leafId: LIVE_LEAF_ID, ptyId: adoptedPtyId })
    const { deps } = testDeps({
      sessions: [listed(adoptedPtyId), listed(unverifiablePtyId)],
      surfaceOwners: new Map([
        [adoptedPtyId, { unowned: true, recorded: placed(adoptedPtyId) }],
        [unverifiablePtyId, null]
      ]),
      resumeCount: 0
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')
  })

  it('leaves every host pane of an unmounted tab to main’s frames', async () => {
    const siblingPtyId = `${WORKTREE_ID}@@live-sibling`
    const hostTabId = '3359f7c8-9bd8-4931-8104-52b6bdbd108d'
    mainHolds(
      { tabId: hostTabId, leafId: LIVE_LEAF_ID, ptyId: LIVE_PTY },
      { tabId: hostTabId, leafId: SIBLING_LEAF_ID, ptyId: siblingPtyId }
    )
    const { deps } = testDeps({
      sessions: [listed(LIVE_PTY), listed(siblingPtyId)],
      surfaceOwners: new Map([
        [LIVE_PTY, placed(LIVE_PTY, hostTabId)],
        [siblingPtyId, placed(siblingPtyId, hostTabId, SIBLING_LEAF_ID)]
      ])
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expectNoWindowWrite(deps.getState())
  })

  it('makes no surface for a live PTY main has not placed yet, and resumes no agent over it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, resume } = testDeps({
      sessions: [listed(LIVE_PTY)],
      surfaceOwners: new Map([[LIVE_PTY, UNOWNED]]),
      sleeping: [sleepingRecord('tab-slept', SIBLING_LEAF_ID, 'slept-session')]
    })

    // The live agent may own the sleeping session: resuming it would start a second writer.
    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('blocked')

    expectNoWindowWrite(deps.getState())
    expect(resume).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[worktree-activation] live PTYs left without a surface',
      expect.objectContaining({ declinedPtyIds: [LIVE_PTY] })
    )
    warn.mockRestore()
  })
})
