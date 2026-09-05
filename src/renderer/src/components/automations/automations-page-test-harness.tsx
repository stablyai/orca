/**
 * The mount rig for AutomationsPage tests: child stand-ins, the preload API
 * double, and the per-test store reset.
 *
 * The presentational children are stood in for because what these tests check
 * is the data flow into them, not their markup — asserting on the real picker,
 * badges, and empty states would test the wrong layer. The stand-ins record the
 * props they were handed so a test can read them back.
 *
 * The `vi.mock` calls live here rather than in each test file: they must run
 * before `./AutomationsPage` is imported, which importing this module first
 * guarantees.
 */

import { act, createElement, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, type Mock, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY as LIST_HOST_SCOPE,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY as OWNER_FENCING,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY as CREATE_IDEMPOTENCY
} from '../../../../shared/protocol-version'
import type { AppState } from '@/store'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostCatalogView } from './use-automation-host-catalog'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import type { AutomationListRow } from './automation-list-row-identity'
import { resetAutomationCapabilityProbes } from './automation-scoped-list-client'
import {
  addRuntimeProject as addRuntimeProjectFixture,
  RUNTIME_REPO_ID as RUNTIME_REPO_ID_FIXTURE,
  RUNTIME_WORKSPACE_ID as RUNTIME_WORKSPACE_ID_FIXTURE,
  selfScopedList
} from './automations-page-runtime-fixtures'

export const RUNTIME_REPO_ID = RUNTIME_REPO_ID_FIXTURE
export const RUNTIME_WORKSPACE_ID = RUNTIME_WORKSPACE_ID_FIXTURE

export type ListPanelProps = {
  filteredExternalAutomationEntries: ExternalAutomationListEntry[]
  selectedExternal: ExternalAutomationListEntry | null
  openEditExternalDialog: (
    manager: ExternalAutomationListEntry['manager'],
    job: ExternalAutomationListEntry['job'],
    scope: ExternalAutomationListEntry['scope']
  ) => void
  externalActionKey: string | null
  requestExternalAction: (
    manager: ExternalAutomationListEntry['manager'],
    job: ExternalAutomationListEntry['job'],
    action: 'run' | 'pause' | 'resume' | 'delete',
    scope: ExternalAutomationListEntry['scope']
  ) => void
  hasListItems: boolean
  hasFilteredListItems: boolean
  filteredRows: readonly AutomationListRow[]
  selectedRowKey: string | null
  selectedExternalKey: string | null
  hostCatalog: AutomationHostCatalogView
  searchCounts: { hostRowCount: number; visibleRowCount: number; searchActive: boolean }
  externalManagersUncheckedNotice: string | null
  isActionEnabled: (row: AutomationListRow, action: string) => boolean
  onSelectHost: (filter: unknown) => void
  selectAutomationRow: (rowKey: string | null) => void
  selectExternalKey: (entryKey: string | null) => void
  onOpenDetail: () => void
  onRefresh: () => void
  runNow: (row: AutomationListRow) => void
  openEditDialog: (row: AutomationListRow) => void
  toggleAutomation: (row: AutomationListRow) => void
  requestDeleteAutomation: (row: AutomationListRow) => void
  openCreateDialog: () => void
  canCreateAutomation: boolean
}

export type DetailPaneProps = {
  selected: Automation | null
  selectedHostEntry: AutomationHostCatalogEntry | null
  selectedRuns: AutomationRun[]
  selectedRunsNotice: { message: string } | null
  runNow: (automation: Automation) => void
  toggleAutomation: (automation: Automation) => void
  requestDeleteAutomation: (automation: Automation) => void
  openEditDialog: (automation: Automation) => void
  fetchExternalAutomationRuns: (input: {
    scope: ExternalAutomationListEntry['scope']
    manager: ExternalAutomationListEntry['manager']
    job: ExternalAutomationListEntry['job']
    page: number
    pageSize: number
  }) => Promise<unknown>
}

export type EditorDialogProps = {
  open: boolean
  isEditing: boolean
  createDestination?: AutomationCreateDestinationControl
  editDestination?: AutomationCreateDestinationControl
  notice?: { message: string; recovery: string | null } | null
  onNoticeRecover?: (action: string) => void
  repos?: { id: string }[]
  draft?: { projectId: string; workspaceId: string }
  onSave: () => void
  onDraftChange: (updater: (current: unknown) => unknown) => void
}

export type DeleteDialogProps = {
  deleteTarget: Automation | null
  onConfirm: () => void
}

type AutomationsPageMocks = {
  state: Record<string, unknown>
  repoMap: Map<string, unknown>
  worktreeMap: Map<string, unknown>
  listPanel: ListPanelProps | null
  detailPane: DetailPaneProps | null
  editorDialog: EditorDialogProps | null
  deleteDialog: DeleteDialogProps | null
  callRuntimeRpc: Mock
  getRuntimeEnvironmentStatus: Mock
  setAutomationHostFilter: Mock
  toastError: Mock
  toastSuccess: Mock
  toastMessage: Mock
  setPendingRunNavigation: Mock
}

// Not `vi.hoisted`: the mock factories below only close over this, and a hoisted
// binding cannot be exported.
export const mocks: AutomationsPageMocks = {
  state: {},
  repoMap: new Map<string, unknown>(),
  worktreeMap: new Map<string, unknown>(),
  listPanel: null,
  detailPane: null,
  editorDialog: null,
  deleteDialog: null,
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentStatus: vi.fn(),
  setAutomationHostFilter: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastMessage: vi.fn(),
  setPendingRunNavigation: vi.fn()
}

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: Partial<AppState>) => unknown): unknown =>
    selector(mocks.state as Partial<AppState>)
  useAppStore.getState = (): Partial<AppState> => mocks.state as Partial<AppState>
  return { useAppStore }
})

vi.mock('@/store/selectors', () => ({
  useRepoMap: () => mocks.repoMap,
  useWorktreeMap: () => mocks.worktreeMap
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args),
  getRuntimeEnvironmentStatus: (...args: unknown[]) => mocks.getRuntimeEnvironmentStatus(...args),
  // Matches the real matcher's contract: the code is a `: <token>` message tail.
  hasRuntimeRpcErrorCode: (error: unknown, code: string) =>
    error instanceof Error && error.message.trimEnd().endsWith(`: ${code}`)
}))

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    message: (...args: unknown[]) => mocks.toastMessage(...args)
  }
}))

vi.mock('@/lib/window-visibility-interval', () => ({
  installWindowVisibilityInterval: () => () => undefined
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => undefined
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: vi.fn(async () => ({ hooks: null, ok: true }))
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn(async () => 'inherit')
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('./AutomationsListPanel', () => ({
  AutomationsListPanel: (props: ListPanelProps) => {
    const selectAutomationRow = (rowKey: string | null): void => {
      props.selectAutomationRow(rowKey)
      props.onOpenDetail()
    }
    mocks.listPanel = { ...props, selectAutomationRow }
    return (
      <div data-testid="list-panel">
        <button aria-label="Refresh automations" onClick={props.onRefresh} />
        {props.filteredRows.map((row) => (
          <button
            type="button"
            data-testid="automation-row"
            key={row.key}
            onClick={() => selectAutomationRow(row.key)}
          >
            {row.automation.name}
          </button>
        ))}
        {props.filteredExternalAutomationEntries.map((entry) => (
          <button
            type="button"
            data-testid="external-row"
            key={entry.key}
            onClick={() => {
              props.selectAutomationRow(null)
              props.selectExternalKey(entry.key)
              props.onOpenDetail()
            }}
          >
            {entry.job.name}
          </button>
        ))}
        {props.hasListItems ? null : <div data-testid="empty-state" />}
      </div>
    )
  }
}))

vi.mock('./AutomationsDetailPane', () => ({
  AutomationsDetailPane: (props: DetailPaneProps) => {
    mocks.detailPane = props
    return (
      <div data-testid="detail-pane">
        <span data-testid="detail-name">{props.selected?.name ?? 'none'}</span>
        <span data-testid="detail-run-count">{props.selectedRuns.length}</span>
      </div>
    )
  }
}))

vi.mock('./AutomationEditorDialog', () => ({
  AutomationEditorDialog: (props: EditorDialogProps) => {
    mocks.editorDialog = props
    return <div data-testid="editor-dialog">{props.open ? 'open' : 'closed'}</div>
  }
}))

vi.mock('./AutomationDeleteDialogs', () => ({
  AutomationDeleteDialog: (props: DeleteDialogProps) => {
    mocks.deleteDialog = props
    return null
  },
  ExternalAutomationDeleteDialog: () => null
}))

import AutomationsPage from './AutomationsPage'
import { makeAutomation, makeRun, makeStoreState } from './automations-page-fixtures'

function mockGroup<K extends string>(...names: K[]): Record<K, Mock> {
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<K, Mock>
}

export const api = {
  automations: mockGroup(
    'list',
    'listRuns',
    'create',
    'update',
    'delete',
    'runNow',
    'listScoped',
    'listExternalManagerForOwner',
    'listExternalRunsForOwner',
    'createExternalForOwner',
    'updateExternalForOwner',
    'runExternalActionForOwner',
    'retainExternalScopes'
  ),
  ssh: mockGroup('listTargets', 'connect'),
  runtimeEnvironments: mockGroup('connect'),
  ui: mockGroup('get')
}

/** The precondition a Desktop + Self row captures; every fenced request repeats it. */
export const SELF_PRECONDITION = { selector: { kind: 'self' } }
/** The owner the catalog projects for Desktop + Self, which every scoped call names. */
export const DESKTOP_SELF_OWNER = { authority: { kind: 'desktop' }, selector: { kind: 'self' } }

export const RUNTIME_ID = 'gpu'
/** A runtime that advertises both automation capabilities, so its rows carry owners. */
const RUNTIME_CAPABILITIES = [LIST_HOST_SCOPE, OWNER_FENCING, CREATE_IDEMPOTENCY]
export const RUNTIME_SELF_FILTER = {
  kind: 'host' as const,
  host: {
    authority: { kind: 'runtime' as const, environmentId: RUNTIME_ID },
    selector: { kind: 'self' as const }
  }
}

/** The local authority's automation RPC surface, served from the same programmable
 *  `api.automations` mocks; an environment target answers from `runtimeHost()` state. */
async function answerAutomationRpc(
  target: unknown,
  method: string,
  params?: unknown
): Promise<unknown> {
  if ((target as { kind?: string } | null)?.kind === 'environment') {
    const answers = mocks.state.runtimeAnswers as
      | { automations: Automation[]; runs: AutomationRun[] }
      | undefined
    if (method === 'automation.list') {
      return selfScopedList(answers?.automations ?? [])
    }
    return method === 'automation.runs' ? { runs: answers?.runs ?? [] } : {}
  }
  const args = params as Record<string, unknown> | undefined
  switch (method) {
    case 'automation.list':
      return args?.selector
        ? await api.automations.listScoped({ selector: args.selector })
        : { automations: await api.automations.list() }
    case 'automation.runs':
      return { runs: await api.automations.listRuns(args) }
    case 'automation.create':
      return { automation: await api.automations.create(args) }
    case 'automation.update':
      return { automation: await api.automations.update(args) }
    case 'automation.delete':
      return await api.automations.delete(args).then(() => ({}))
    case 'automation.runNow':
      return { run: await api.automations.runNow(args) }
    default:
      return {}
  }
}

/** Puts a reachable, capable second authority in the catalog and answers for it. */
export function runtimeHost(automations: Automation[], runs: AutomationRun[]): void {
  mocks.state.runtimeEnvironments = [
    { id: RUNTIME_ID, name: 'GPU box', createdAt: 1, pairingRevision: 4 }
  ]
  mocks.state.runtimeStatusByEnvironmentId = new Map([
    [RUNTIME_ID, { status: { capabilities: RUNTIME_CAPABILITIES } }]
  ])
  mocks.getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities: RUNTIME_CAPABILITIES })
  mocks.state.runtimeAnswers = { automations, runs }
}

export const addRuntimeProject = (): void => addRuntimeProjectFixture(mocks, RUNTIME_ID)

/** Answers the host-scoped read, which is where the list's rows and owners come from. */
export function scopedList(automations: Automation[]): void {
  api.automations.listScoped.mockResolvedValue(selfScopedList(automations))
}

const roots: Root[] = []

export async function renderPage(options?: { strict?: boolean }): Promise<{
  container: HTMLDivElement
  rerender: () => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const rerender = async (): Promise<void> => {
    await act(async () => {
      // Strict mounts double-invoke effects the way the dev app does, which is
      // where a dispose-without-revive lifecycle bug becomes visible.
      const page = options?.strict
        ? createElement(StrictMode, null, createElement(AutomationsPage))
        : createElement(AutomationsPage)
      root.render(page)
    })
  }
  await rerender()
  return { container, rerender }
}

/** Lets the per-host queries, their capability probes, and the history read settle. */
export async function settleHostQueries(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** The alt-tab-back trigger: one of the two events bound to the page refresh. */
export async function refreshOnFocus(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * The row the page actually listed for an ID, so tests act through the same
 * authority-qualified key the user's click carries rather than a synthesized one.
 */
export function listedRow(automationId: string): AutomationListRow {
  const row = mocks.listPanel?.filteredRows.find((entry) => entry.automation.id === automationId)
  if (!row) {
    throw new Error(`no listed row for ${automationId}`)
  }
  return row
}

export function rows(container: HTMLElement, testId: string): string[] {
  return [...container.querySelectorAll(`[data-testid="${testId}"]`)].map(
    (node) => node.textContent ?? ''
  )
}

/** Registers the reset both page test files depend on; call once per file. */
export function installAutomationsPageHarness(): void {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    // Confirmed capabilities are module-level and must not leak between tests.
    resetAutomationCapabilityProbes()
    // A prior test's wholesale mockImplementation must not leak forward.
    mocks.callRuntimeRpc.mockReset()
    mocks.callRuntimeRpc.mockImplementation(answerAutomationRpc)
    mocks.listPanel = null
    mocks.detailPane = null
    mocks.editorDialog = null
    mocks.deleteDialog = null
    const fixtures = makeStoreState()
    mocks.state = fixtures.state
    mocks.state.setAutomationHostFilter = mocks.setAutomationHostFilter
    mocks.repoMap = fixtures.repoMap
    mocks.worktreeMap = fixtures.worktreeMap
    api.automations.list.mockResolvedValue([makeAutomation()])
    api.automations.listRuns.mockResolvedValue([])
    api.automations.listExternalManagerForOwner.mockResolvedValue({
      manager: null,
      error: null,
      updatedAt: 0
    })
    api.automations.retainExternalScopes.mockResolvedValue(undefined)
    api.automations.listScoped.mockResolvedValue(selfScopedList([makeAutomation()]))
    api.automations.create.mockResolvedValue(makeAutomation())
    api.automations.update.mockResolvedValue(makeAutomation())
    api.automations.delete.mockResolvedValue(undefined)
    api.automations.runNow.mockResolvedValue(makeRun())
    api.ui.get.mockResolvedValue({})
    // @ts-expect-error test window mock
    globalThis.window.api = api
  })

  afterEach(async () => {
    await act(async () => {
      roots.splice(0).forEach((root) => root.unmount())
    })
    document.body.innerHTML = ''
  })
}
