import RunningTerminalCloseDialog from '../terminal-pane/layout/close/RunningTerminalCloseDialog'
import { allTabs, contexts, state } from './worker-tabs-evidence-fixture-data'
import { toast } from 'sonner'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { defineFixture, type ComponentFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { AppState } from '@/store/types'
import { Toaster } from '../ui/sonner'
import { WorkerTabsFixtureStrip } from './worker-tabs-fixture-scene'
import { groupId, workspace, seed, leafIds } from './worker-tabs-fixture-data'
import WorkerTabConfirmDialog from './WorkerTabConfirmDialog'
import { requestWorkerTabConfirm, type WorkerTabConfirmKind } from './worker-tab-confirm-request'
import { openCoordinatorWorkers } from './CoordinatorWorkersBadge'
import { hideWorkerTab } from './worker-tab-hide'
import { handleWorkerTabUserClose, keepWorkerPaneOnClose } from './worker-tab-user-close'
import { closeWorkerTab, stopWorker } from './worker-tab-explicit-actions'
import type { WorkerStopReceipt } from '../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import { WorkerTabsSetting } from '../settings/agents/behavior/WorkerTabsSetting'
import { SplitPaneLanding } from '../tab-group/landing/SplitPaneLanding'

let originalCall: typeof window.api.runtime.call | undefined
function reset(): void {
  originalCall ??= window.api.runtime.call
  window.api.runtime.call = originalCall
  toast.dismiss()
  openCoordinatorWorkers(null)
}
function Scene({ landing = false }: { landing?: boolean }): React.JSX.Element {
  const active = useAppStore((s) => s.groupsByWorktree[workspace]?.[0]?.activeTabId)
  return (
    <ConfirmationDialogProvider>
      <div className="h-80 bg-background">
        <WorkerTabsFixtureStrip />
        {landing && !active ? (
          <SplitPaneLanding
            worktreeId={workspace}
            groupId={groupId}
            autoFocus={false}
            onClosePane={undefined}
          />
        ) : null}
      </div>
      <WorkerTabConfirmDialog />
      <RunningTerminalCloseDialog />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </ConfirmationDialogProvider>
  )
}
function scene(
  store: Partial<AppState> = {},
  interact?: ComponentFixture['interact']
): ComponentFixture {
  return {
    width: 800,
    store: { ...state, ...store },
    setup: reset,
    render: () => <Scene />,
    ...(interact ? { interact } : {})
  }
}
export const workers = defineFixture(scene({}, () => openCoordinatorWorkers('tab-0')))
const receiverTabs = allTabs.map((tab) =>
  tab.workerTab
    ? {
        ...tab,
        workerTab: {
          ...tab.workerTab,
          origin: { ...tab.workerTab.origin, stopRequiresHome: true as const }
        }
      }
    : tab
)
const receiverState: Partial<AppState> = { unifiedTabsByWorktree: { [workspace]: receiverTabs } }
export const receiverWorkers = defineFixture(
  scene(receiverState, () => openCoordinatorWorkers('tab-0'))
)
export const receiverMenu = defineFixture(
  scene(receiverState, async (frame) => {
    frame
      .querySelector('[data-tab-id="tab-1"]')
      ?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 280, clientY: 30 })
      )
    await new Promise(requestAnimationFrame)
  })
)
export const receiverShortcutToast = defineFixture(
  scene(receiverState, async () => {
    await stopWorker(workspace, receiverTabs[1]!)
  })
)
export const receiverFinishedDialog = defineFixture(
  scene(receiverState, () =>
    requestWorkerTabConfirm({
      kind: 'close-finished',
      worktreeId: workspace,
      tab: receiverTabs[4]!
    })
  )
)
export const zeroBadgeWorkers = defineFixture(
  scene(
    {
      runtimeAgentOrchestrationByPaneKey: Object.fromEntries(
        Object.entries(contexts).map(([key, c]) => [
          key,
          { ...c, attention: { categories: [], requiresAction: false } }
        ])
      )
    },
    async (frame) => {
      frame
        .querySelector('[data-tab-id="tab-0"]')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 180, clientY: 30 })
        )
      await new Promise(requestAnimationFrame)
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (e) => e.textContent === 'Workers…'
      )
      if (!item) {
        throw new Error('Coordinator Workers menu missing')
      }
      item.click()
    }
  )
)
function dialog(kind: WorkerTabConfirmKind): ComponentFixture {
  return scene({}, () =>
    requestWorkerTabConfirm({
      kind,
      worktreeId: workspace,
      tab: allTabs[kind === 'close-finished' ? 4 : 1]!
    })
  )
}
export const stopDialog = defineFixture(dialog('stop'))
export const closeRunningDialog = defineFixture(dialog('close-running'))
export const closeFinishedDialog = defineFixture(dialog('close-finished'))
export const runningHideToast = defineFixture(
  scene({ workerTabHideHintShown: false }, () => {
    hideWorkerTab('tab-1')
  })
)
export const unreachableHideToast = defineFixture(
  scene(
    {
      agentStatusByPaneKey: acceptedAgentStatuses(),
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    },
    () => {
      hideWorkerTab('tab-1')
    }
  )
)
function receiptToast(receipt: WorkerStopReceipt | null, close = false): ComponentFixture {
  const fixture = scene({}, async () => {
    await (close ? closeWorkerTab(workspace, allTabs[1]!) : stopWorker(workspace, allTabs[1]!))
  })
  return {
    ...fixture,
    setup: () => {
      reset()
      const fallback = window.api.runtime.call
      window.api.runtime.call = async (request) =>
        request.method !== 'orchestration.workerStop'
          ? fallback(request)
          : receipt
            ? { id: 'fixture', ok: true, result: receipt, _meta: { runtimeId: 'fixture' } }
            : {
                id: 'fixture',
                ok: false,
                error: { code: 'worker_stop_refused', message: 'Worker stop refused' }
              }
    }
  }
}
export const unconfirmedStopToast = defineFixture(
  receiptToast({
    dispatchId: 'dispatch-1',
    state: 'stopped',
    alreadySettled: false,
    processAction: 'none',
    warning: 'Assignment only'
  })
)
export const refusedStopToast = defineFixture(receiptToast(null))
export const helperStopToast = defineFixture(
  receiptToast({
    dispatchId: 'dispatch-1',
    state: 'stopped',
    alreadySettled: false,
    processAction: 'closed_agent_terminal',
    helpers: [{ dispatchId: 'helper', creatorDispatchId: 'dispatch-1', outcome: 'unconfirmed' }]
  })
)
export const alwaysOpen = defineFixture(scene({ workerTabsMode: 'always-open' }))
export const emptyLanding = defineFixture({
  ...scene(
    {
      unifiedTabsByWorktree: { [workspace]: [allTabs[1]!] },
      tabsByWorktree: { [workspace]: [state.tabsByWorktree![workspace]![1]!] },
      groupsByWorktree: {
        [workspace]: [
          {
            id: groupId,
            worktreeId: workspace,
            activeTabId: 'tab-1',
            tabOrder: ['tab-1'],
            recentTabIds: ['tab-1']
          }
        ]
      },
      workerTabPeekByGroupId: {},
      workerTabStripChoiceByWorktree: { [workspace]: { 'tab-1': 'kept' } }
    },
    () => {
      hideWorkerTab('tab-1')
    }
  ),
  render: () => <Scene landing />
})
const settings = (mode: AppState['workerTabsMode']): ComponentFixture => ({
  width: 800,
  store: { workerTabsMode: mode },
  setup: reset,
  render: () => (
    <div className="bg-card px-4">
      <WorkerTabsSetting />
    </div>
  )
})
export const settingOnClick = defineFixture(settings('open-when-clicked'))
export const settingAlways = defineFixture(settings('always-open'))

export const twoNeeds = defineFixture(
  scene({
    runtimeAgentOrchestrationByPaneKey: {
      ...contexts,
      [`tab-1:${leafIds[1]}`]: {
        ...contexts[`tab-1:${leafIds[1]}`]!,
        attention: { categories: ['input'], requiresAction: true }
      }
    }
  })
)
export const unknownWorker = defineFixture(scene({ runtimeAgentOrchestrationByPaneKey: {} }))
export const finishedWorker = defineFixture(
  scene({
    groupsByWorktree: {
      [workspace]: [
        {
          ...seed.groupsByWorktree[workspace][0]!,
          activeTabId: 'tab-4',
          tabOrder: allTabs.map((t) => t.id)
        }
      ]
    },
    workerTabPeekByGroupId: { [groupId]: 'tab-4' }
  })
)
export const unconfirmedCloseToast = defineFixture(
  receiptToast(
    { dispatchId: 'dispatch-1', state: 'stopped', alreadySettled: false, processAction: 'unknown' },
    true
  )
)

// tab-2's worker shares its tab with a terminal pane the user split in.
const userLeafId = '00000000-0000-4000-8000-0000000000aa'
const mixedTab2: Partial<AppState> = {
  terminalLayoutsByTabId: {
    ...state.terminalLayoutsByTabId,
    'tab-2': {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: leafIds[2]! },
        second: { type: 'leaf', leafId: userLeafId }
      },
      activeLeafId: userLeafId,
      expandedLeafId: null
    }
  }
}
const onlyTab1: Partial<AppState> = {
  unifiedTabsByWorktree: { [workspace]: [allTabs[0]!, allTabs[1]!] },
  groupsByWorktree: {
    [workspace]: [
      {
        id: groupId,
        worktreeId: workspace,
        activeTabId: 'tab-1',
        tabOrder: ['tab-0', 'tab-1'],
        recentTabIds: ['tab-0', 'tab-1']
      }
    ]
  },
  workerTabPeekByGroupId: {}
}
export const paneKeptOneWorker = defineFixture(
  scene(onlyTab1, () => {
    keepWorkerPaneOnClose(workspace, groupId)
  })
)
export const paneKeptFoldedWorkers = defineFixture(
  scene({}, () => {
    keepWorkerPaneOnClose(workspace, groupId)
  })
)
export const paneKeptFoldedShow = defineFixture(
  scene({}, async () => {
    keepWorkerPaneOnClose(workspace, groupId)
    await new Promise(requestAnimationFrame)
    const show = [...document.querySelectorAll<HTMLElement>('[data-button]')].find(
      (button) => button.textContent === 'Show'
    )
    if (!show) {
      throw new Error('Show action missing')
    }
    show.click()
  })
)
export const paneKeptMixed = defineFixture(
  scene(mixedTab2, () => {
    keepWorkerPaneOnClose(workspace, groupId)
  })
)
export const mixedTabCloseKept = defineFixture(
  scene(mixedTab2, () => {
    handleWorkerTabUserClose('tab-2')
  })
)
export const closeOthersKeptMixed = defineFixture(
  scene(mixedTab2, () => {
    useAppStore.getState().closeOtherTabs('tab-0')
  })
)

const workerMenu = (store: Partial<AppState> = {}, tabId = 'tab-1'): ComponentFixture =>
  scene(store, async (frame) => {
    frame
      .querySelector(`[data-tab-id="${tabId}"]`)
      ?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 280, clientY: 30 })
      )
    await new Promise(requestAnimationFrame)
  })
export const localMenu = defineFixture(workerMenu())
export const mixedMenu = defineFixture(workerMenu(mixedTab2, 'tab-2'))
export const localAlwaysMenu = defineFixture(workerMenu({ workerTabsMode: 'always-open' }))
export const receiverAlwaysMenu = defineFixture(
  workerMenu({ ...receiverState, workerTabsMode: 'always-open' })
)
