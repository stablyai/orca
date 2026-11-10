import type {
  ListPanelProps,
  EditorDialogProps,
  DeleteDialogProps
} from './automations-page-child-props.test-fixture'
import { resetHostStructuredAgentsForTests } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
/** Record child props to test page orchestration rather than presentation. Import this harness first so shared vi.mock registrations precede AutomationsPage loading. */

import { act, createElement, StrictMode, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, type Mock, vi } from 'vitest'

import type { Automation } from '../../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'

import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY as LIST_HOST_SCOPE,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY as OWNER_FENCING,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY as CREATE_IDEMPOTENCY
} from '../../../../shared/automations/automation-runtime-capabilities'
import type { AppState } from '@/store/types'

import { AutomationDestinationField } from './authoring/AutomationDestinationField'
import { TooltipProvider } from '@/components/ui/tooltip'

import { resetAutomationCapabilityProbes } from './hosts/automation-capability-probe'
import {
  addRuntimeProject as addRuntimeProjectFixture,
  selfScopedList
} from './automations-page-runtime-fixtures'

type AutomationsPageMocks = {
  state: AutomationsPageFixtureState
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

// Mock factories only close over this exported binding; vi.hoisted bindings cannot be exported.
export const mocks: AutomationsPageMocks = {
  state: { repos: [], projectHostSetups: [], worktreesByRepo: {} },
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

vi.mock('@/store/index', () => {
  const useAppStore = (selector: (state: Partial<AppState>) => unknown): unknown =>
    selector(mocks.state as Partial<AppState>)
  useAppStore.getState = (): Partial<AppState> => mocks.state as Partial<AppState>
  return { useAppStore }
})

vi.mock('@/store/repos/use-repository-catalog', () => ({
  useRepoMap: () => mocks.repoMap
}))
vi.mock('@/store/slices/worktrees/listing/use-worktree-catalog', () => ({
  useWorktreeMap: () => mocks.worktreeMap
}))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args)
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  getRuntimeEnvironmentStatus: (...args: unknown[]) => mocks.getRuntimeEnvironmentStatus(...args)
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
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

vi.mock('@/runtime/repo-hooks/runtime-hooks-client', () => ({
  checkRuntimeHooks: vi.fn(async () => ({ hooks: null, ok: true }))
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: vi.fn(async () => 'inherit'),
  ensureHooksApproved: vi.fn(async () => ({ decision: 'run' }))
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('./listing/AutomationsListPanel', () => ({
  AutomationsListPanel: (props: ListPanelProps) => {
    const selectAutomationRow = (rowKey: string | null): void => {
      props.selectAutomationRow(rowKey)
      props.onOpenDetail()
    }
    mocks.listPanel = { ...props, selectAutomationRow }
    return (
      <div data-testid="list-panel">
        <button aria-label="Refresh automations" onClick={props.onRefresh} />
        <button onClick={props.onOpenRuns}>Runs</button>
        {props.sortedListItems.map((item) =>
          item.kind === 'local' ? (
            <button
              type="button"
              data-testid="automation-row"
              key={item.id}
              onClick={() => selectAutomationRow(item.id)}
            >
              {item.row.automation.name}
            </button>
          ) : (
            <button
              type="button"
              data-testid="external-row"
              key={item.id}
              onClick={() => {
                props.selectAutomationRow(null)
                props.selectExternalKey(item.id)
                props.onOpenDetail()
              }}
            >
              {item.entry.job.name}
            </button>
          )
        )}
        {props.hasListItems ? null : <div data-testid="empty-state" />}
      </div>
    )
  }
}))

vi.mock('./details/AutomationsDetailPane', () => ({
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

vi.mock('./authoring/AutomationEditorDialog', () => ({
  AutomationEditorDialog: (props: EditorDialogProps) => {
    mocks.editorDialog = props
    return (
      <div data-testid="editor-dialog">
        {props.open ? 'open' : 'closed'}
        {props.open && props.editDestination ? (
          <TooltipProvider>
            <AutomationDestinationField control={props.editDestination} />
            <button data-testid="editor-save" disabled={!props.canSave} onClick={props.onSave}>
              Save changes
            </button>
          </TooltipProvider>
        ) : null}
      </div>
    )
  }
}))

vi.mock('./authoring/AutomationDeleteDialogs', () => ({
  AutomationDeleteDialog: (props: DeleteDialogProps) => {
    mocks.deleteDialog = props
    return null
  },
  ExternalAutomationDeleteDialog: () => null
}))

import AutomationsPage from './AutomationsPage'
import {
  makeAutomation,
  makeRun,
  makeStoreState,
  type AutomationsPageFixtureState,
  type DetailPaneProps
} from './automations-page-fixtures'

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

/** Serve desktop-local RPCs from the programmable API mocks and runtime-target RPCs from runtimeHost state. */
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
      // StrictMode doubles effects to expose dispose-without-revive controller bugs.
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

export function rows(container: HTMLElement, testId: string): string[] {
  return [...container.querySelectorAll(`[data-testid="${testId}"]`)].map(
    (node) => node.textContent ?? ''
  )
}

/** Registers the per-case store reset and renderer cleanup for the current suite. */
export function installAutomationsPageHarness(): void {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    setLocalRuntimeCapabilitiesForTests([])
    // Confirmed capabilities are module-level and must not leak between tests.
    resetAutomationCapabilityProbes()
    resetHostStructuredAgentsForTests()
    // A prior test's wholesale mockImplementation must not leak forward.
    mocks.callRuntimeRpc.mockReset()
    mocks.callRuntimeRpc.mockImplementation(answerAutomationRpc)
    mocks.listPanel = null
    mocks.detailPane = null
    mocks.editorDialog = null
    mocks.deleteDialog = null
    const fixtures = makeStoreState()
    mocks.state = fixtures.state
    mocks.state.folderWorkspaces = []
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
    setLocalRuntimeCapabilitiesForTests(null)
  })
}
