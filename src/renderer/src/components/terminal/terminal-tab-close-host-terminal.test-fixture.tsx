import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import { act, fireEvent, render } from '@testing-library/react'
import { expect, vi, type Mock } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import SortableTab from '../tab-bar/SortableTab'
import { createTerminalTabOnHost } from '../tab-bar/tab-bar-host-terminal-create'
import { createWorkspaceTabCloseCommands } from '../tab-group/workspace-tab-close-commands'
import { resolveGroupTabFromVisibleId } from '../tab-group/tab-group-visible-id'
import { buildTerminalTabRetirementPlan } from '@/store/slices/terminal-tab-retirement'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { applyWebSessionTabsStorePatch } from '@/runtime/web-session-tabs-sync/store-patch'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'

// Moved verbatim from terminal-tab-close-host-terminal.test.tsx so its cases stay within max-lines.
// Only the preload bridge is a double: everything between the rendered X and it is product code.
// Why not vi.hoisted: no vi.mock reads it, and a hoisted value cannot be exported.
export const transport: { runtimeCall: Mock; environmentCall: Mock; ptyKill: Mock } = {
  runtimeCall: vi.fn(),
  environmentCall: vi.fn(),
  ptyKill: vi.fn()
}

export const WT = 'repo1::/client/repo1'
export const ENV = 'env-1'
export const HOST = 'runtime:env-1'
export const PAIRING_REVISION = 7
export const SERVER = {
  tabId: 'server-tab-8a',
  worktreeId: 'server-wt-9',
  handles: ['term_srv_a', 'term_srv_b']
}
export const LOCAL_PTY = 'pty-local-1'
export const REPO = {
  id: 'repo1',
  path: '/client/repo1',
  displayName: 'repo1',
  badgeColor: '#000',
  addedAt: 0,
  executionHostId: 'local' as const
}
export const ENVIRONMENT = {
  id: ENV,
  name: 'dev box',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: PAIRING_REVISION,
  lastUsedAt: null,
  runtimeId: ENV,
  preferredEndpointId: 'endpoint',
  endpoints: [{ id: 'endpoint', kind: 'websocket' as const, label: ENV, endpoint: 'ws://host' }]
}
export const ptyFor = (handle: string): string => `remote:${ENV}@@${handle}`

export function installTransport(): void {
  transport.runtimeCall.mockReset().mockImplementation(async ({ method }: { method: string }) => ({
    id: 'local',
    ok: true,
    result:
      method === 'terminal.create'
        ? {
            terminal: {
              handle: SERVER.handles[0],
              worktreeId: SERVER.worktreeId,
              tabId: SERVER.tabId,
              title: null,
              executionHostId: HOST,
              ptyId: ptyFor(SERVER.handles[0])
            }
          }
        : {}
  }))
  transport.environmentCall.mockReset().mockImplementation(
    async (args: { method: string }) =>
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
        id: 'env',
        ok: true,
        result: args.method === 'terminal.close' ? { closed: true } : {},
        _meta: { runtimeId: ENV }
      }
  )
  transport.ptyKill.mockReset().mockResolvedValue(undefined)
  Object.assign(window, {
    api: {
      runtime: { call: transport.runtimeCall },
      runtimeEnvironments: { call: transport.environmentCall },
      pty: { kill: transport.ptyKill }
    }
  })
}

export function seedClientState(
  worktrees = [makeWorktree({ id: WT, repoId: 'repo1', path: REPO.path, projectId: 'project-1' })]
): void {
  // Why: the app records pairing revisions here when it loads its environments.
  replaceRuntimeEnvironmentRevisions([ENVIRONMENT])
  useAppStore.setState({
    repos: [REPO],
    worktreesByRepo: { repo1: worktrees },
    runtimeEnvironments: [ENVIRONMENT],
    settings: {
      ...getDefaultSettings('/home/test'),
      skipCloseTerminalWithRunningProcessConfirm: true
    },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    activeWorktreeId: WT
  })
}

/** Adopts a second host PTY into a fresh client leaf, as host split does after its terminal.split reply. */
export function adoptSecondPane(tabId: string, ptyId: string): void {
  const state = useAppStore.getState()
  const layout = state.terminalLayoutsByTabId[tabId]
  const firstLeaf = layout?.root?.type === 'leaf' ? layout.root.leafId : null
  if (!layout || !firstLeaf) {
    throw new Error('expected a single-leaf adopted layout')
  }
  const secondLeaf = createBrowserUuid()
  const split: TerminalLayoutSnapshot = {
    ...layout,
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: firstLeaf },
      second: { type: 'leaf', leafId: secondLeaf }
    },
    ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [secondLeaf]: ptyId }
  }
  state.setTabLayout(tabId, split)
  state.updateTabPtyId(tabId, ptyId)
}

export async function createHostTab(): Promise<string> {
  const result = await createTerminalTabOnHost({
    worktreeId: WT,
    groupId: 'group-1',
    executionHostId: HOST,
    projectHostSetupId: 'env-setup'
  })
  if (result.status !== 'created') {
    throw new Error(`host create refused: ${JSON.stringify(result)}`)
  }
  return result.tabId
}

/** Renders the real tab with its X wired as TabGroupPanel wires it, then clicks the X. */
export async function clickRenderedX(tabId: string): Promise<void> {
  const state = useAppStore.getState()
  const row = (state.tabsByWorktree[WT] ?? []).find((tab) => tab.id === tabId)
  const unified = (state.unifiedTabsByWorktree[WT] ?? []).find((tab) => tab.entityId === tabId)
  if (!row || !unified) {
    throw new Error('expected the tab in the client store')
  }
  const groupTabs = (state.unifiedTabsByWorktree[WT] ?? []).filter(
    (tab) => tab.groupId === unified.groupId
  )
  const commands = createWorkspaceTabCloseCommands({ worktreeId: WT, groupTabs })
  const onClose = (terminalId: string): void => {
    const item = resolveGroupTabFromVisibleId(groupTabs, terminalId)
    if (item?.contentType === 'terminal') {
      commands.closeItem(item.id)
    }
  }
  const noop = vi.fn()
  const view = render(
    <DndContext>
      <SortableContext items={[unified.id]}>
        <TooltipProvider>
          <SortableTab
            tab={row}
            agent={null}
            unifiedTabId={unified.id}
            groupId={unified.groupId}
            tabCount={1}
            hasTabsToRight={false}
            hasTabsToLeft={false}
            isActive
            isPinned={false}
            isExpanded={false}
            onActivate={noop}
            onClose={onClose}
            onCloseOthers={noop}
            onCloseToRight={noop}
            onCloseToLeft={noop}
            onSetCustomTitle={noop}
            onSetTabColor={noop}
            onTogglePin={noop}
            onToggleExpand={noop}
            dragData={{
              kind: 'tab',
              worktreeId: WT,
              groupId: unified.groupId,
              unifiedTabId: unified.id,
              visibleTabId: tabId,
              tabType: 'terminal',
              label: row.title
            }}
          />
        </TooltipProvider>
      </SortableContext>
    </DndContext>
  )
  const close = view.container.querySelector('[data-tab-close-button="true"]')
  if (!close) {
    throw new Error('rendered tab has no close button')
  }
  await act(async () => {
    fireEvent.click(close)
  })
}

type EnvironmentCall = {
  selector: string
  method: string
  params?: unknown
  expectedEnvironmentPairingRevision?: number
}

function isEnvironmentCall(value: unknown): value is EnvironmentCall {
  return (
    typeof value === 'object' &&
    value !== null &&
    'selector' in value &&
    typeof value.selector === 'string' &&
    'method' in value &&
    typeof value.method === 'string' &&
    (!('expectedEnvironmentPairingRevision' in value) ||
      value.expectedEnvironmentPairingRevision === undefined ||
      typeof value.expectedEnvironmentPairingRevision === 'number')
  )
}

function toEnvironmentCall(value: unknown): EnvironmentCall {
  if (!isEnvironmentCall(value)) {
    throw new Error('malformed environment call observed')
  }
  return value
}

function terminalHandle(params: unknown): string {
  if (typeof params === 'object' && params !== null && 'terminal' in params) {
    if (typeof params.terminal === 'string') {
      return params.terminal
    }
  }
  throw new Error('terminal.close call carries no terminal handle')
}

export const callsTo = (method: string) =>
  transport.environmentCall.mock.calls
    .map(([args]) => toEnvironmentCall(args))
    .filter((args) => args.method === method)
export const hostTabCloses = () => [
  ...callsTo('session.tabs.close'),
  ...callsTo('session.tabs.closeLifecycle')
]

export function expectLocalTerminalUntouched(localTabId: string): void {
  expect(transport.ptyKill).not.toHaveBeenCalled()
  const state = useAppStore.getState()
  expect((state.tabsByWorktree[WT] ?? []).some((tab) => tab.id === localTabId)).toBe(true)
  expect(state.ptyIdsByTabId[localTabId]).toEqual([LOCAL_PTY])
}

export const TARGET_WT = SERVER.worktreeId
// Server-side leaves: deliberately unlike every client leaf the store mints.
export const SERVER_LEAVES = [
  '5e7e0a01-0000-4000-8000-000000000001',
  '5e7e0a01-0000-4000-8000-000000000002'
]
export const MIRRORED_TAB_ID = toWebTerminalSurfaceTabId(SERVER.tabId)

/** CONSTRUCTED host frame, not a captured one: the target's own session.tabs view of SERVER.tabId. */
function constructedTargetFrame(handles: readonly string[]): RuntimeMobileSessionTabsResult {
  return {
    worktree: TARGET_WT,
    publicationEpoch: 'constructed-epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'server-group-1',
    activeTabId: `${SERVER.tabId}::${SERVER_LEAVES[0]}`,
    activeTabType: 'terminal',
    tabs: handles.map((terminal, index) => ({
      type: 'terminal' as const,
      id: `${SERVER.tabId}::${SERVER_LEAVES[index]}`,
      title: 'host shell',
      parentTabId: SERVER.tabId,
      leafId: SERVER_LEAVES[index]!,
      isActive: index === 0,
      status: 'ready' as const,
      terminal
    }))
  }
}

/** Runs the frame through the production mirror producer, as the all-worktree subscription does. */
export function applyProductionMirror(handles: readonly string[]): void {
  applyWebSessionTabsStorePatch(
    (state) => applyWebSessionTabsSnapshot(state, constructedTargetFrame(handles), ENV),
    { frames: [] }
  )
}

/** What the production mirror actually materialized; asserted, never written by the test. */
export function observedMirror() {
  const state = useAppStore.getState()
  const unified = (state.unifiedTabsByWorktree[TARGET_WT] ?? []).find(
    (tab) => tab.entityId === MIRRORED_TAB_ID
  )
  return {
    row: (state.tabsByWorktree[TARGET_WT] ?? []).some((tab) => tab.id === MIRRORED_TAB_ID),
    ptyIds: state.ptyIdsByTabId[MIRRORED_TAB_ID] ?? [],
    stamped: unified?.projectHostSetupId !== undefined,
    // The mirror's real group-placed layout leaves: server leaf ids, each bound to the handle.
    leafIds: collectLayoutLeafIdsInOrder(state.terminalLayoutsByTabId[MIRRORED_TAB_ID]?.root),
    groupLeafPtyIds: userFacingLeafPtyIds(TARGET_WT, MIRRORED_TAB_ID)
  }
}

/** The real planner's read-only view plus the dispatched closes, in one value so a RED shows both. */
export async function closeOutcome(hostTabId: string) {
  const plan = buildTerminalTabRetirementPlan(useAppStore.getState(), hostTabId)
  await clickRenderedX(hostTabId)
  await vi
    .waitFor(() => expect(callsTo('terminal.close').length).toBeGreaterThan(0))
    .catch(() => {})
  const byHandle = (a: { handle: string }, b: { handle: string }) =>
    a.handle.localeCompare(b.handle)
  return {
    sharedPtyIds: plan.sharedPtyIds,
    runtimeTerminals: plan.runtimeTerminals
      .map(({ environmentId, handle }) => ({ environmentId, handle }))
      .sort(byHandle),
    terminalCloses: callsTo('terminal.close')
      .map((call) => ({
        selector: call.selector,
        handle: terminalHandle(call.params)
      }))
      .sort(byHandle)
  }
}

/** PTYs the user can see for a tab: its layout's leaves, only while the tab sits in a tab group. */
export function userFacingLeafPtyIds(worktreeId: string, tabId: string): string[] {
  const state = useAppStore.getState()
  const unified = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.entityId === tabId
  )
  const placed = (state.groupsByWorktree[worktreeId] ?? []).some((group) =>
    group.tabOrder.includes(unified?.id ?? '')
  )
  const layout = state.terminalLayoutsByTabId[tabId]
  return placed
    ? collectLayoutLeafIdsInOrder(layout?.root).flatMap((leafId) => {
        const ptyId = layout?.ptyIdsByLeafId?.[leafId]
        return ptyId ? [ptyId] : []
      })
    : []
}
