import type * as ReactModule from 'react'
import type { LinearEditState } from '../../../linear-item-drawer-types'

import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { defaultScopeSource } from '@/runtime/hosts/selection/default-creation-host'
import { LinearIssueTextEditor } from '../../../LinearIssueTextEditor'
import { useLinearIssueEditController } from '../../../linear-item-drawer-edit-controller'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import { useStore } from 'zustand'

import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { cleanup } from '@testing-library/react'
import { createTestStore, issue } from '../../../../store/slices/linear/linear-slice-test-harness'
import { clearLinearRequestMaps } from '../../../../store/slices/linear/linear-slice-request-state'

const deferredIssueSetters = vi.hoisted(() => {
  const updates: VoidFunction[] = []
  return { enabled: false, updates }
})
vi.mock('react', async (original) => {
  const actual = await original<typeof ReactModule>()
  return {
    ...actual,
    useReducer<S, A>(reducer: (previous: S, action: A) => S, initial: S) {
      const [value, dispatch] = actual.useReducer(reducer, initial)
      const send = actual.useCallback((action: A) => {
        if (
          deferredIssueSetters.enabled &&
          typeof initial === 'object' &&
          initial !== null &&
          'whole' in initial
        ) {
          deferredIssueSetters.updates.push(() => dispatch(action))
        } else {
          dispatch(action)
        }
      }, [])
      return [value, send] as const
    }
  }
})
export { deferredIssueSetters }

const active = vi.hoisted(() => ({ store: vi.fn<() => Store>() }))

vi.mock('@/store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: ReturnType<Store['getState']>) => unknown) =>
      useStore(active.store(), selector),
    {
      getState: () => active.store().getState(),
      subscribe: (...args: Parameters<Store['subscribe']>) => active.store().subscribe(...args)
    }
  )
}))

vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (match, key) => values?.[key] ?? match)
}))

const reads: {
  list: Mock
  search: Mock
  project: Mock
  view: Mock
  detail: Mock
  update: Mock
  create: Mock
  projects: Mock
  connect: Mock
  test: Mock
  select: Mock
} = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  project: vi.fn(),
  view: vi.fn(),
  detail: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  projects: vi.fn(),
  connect: vi.fn(),
  test: vi.fn(),
  select: vi.fn()
}))

const accountViewer = vi.hoisted(() => ({
  displayName: 'User',
  email: null,
  organizationName: 'Acme'
}))

vi.mock('@/runtime/linear/runtime-linear-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearTestConnection: (...args: unknown[]) => reads.test(...args),
  linearSelectWorkspace: (...args: unknown[]) => reads.select(...args),
  linearDisconnect: async () => {},
  linearConnect: (...args: unknown[]) => reads.connect(...args),
  linearStatus: async () => ({ connected: true, viewer: accountViewer, selectedWorkspaceId: 'w' }),
  linearListIssues: (...args: unknown[]) => reads.list(...args),
  linearSearchIssues: (...args: unknown[]) => reads.search(...args)
}))

vi.mock('@/runtime/linear/runtime-linear-project-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearListProjects: reads.projects,
  linearTeamStates: async () => [{ id: 'done', name: 'Done', type: 'completed', color: '#888888' }],
  linearListProjectIssues: (...args: unknown[]) => reads.project(...args),
  linearListCustomViewIssues: (...args: unknown[]) => reads.view(...args)
}))

vi.mock('@/runtime/linear/runtime-linear-issue-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearGetIssue: reads.detail,
  linearIssueComments: async () => [],
  linearUpdateIssue: reads.update,
  linearCreateIssue: reads.create
}))

vi.mock('@/hooks/useIssueMetadata', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useTeamLabels: () => ({ data: [{ id: 'bug', name: 'Bug' }], loading: false }),
  useTeamMembers: () => ({ data: [], loading: false }),
  clearLinearMetadataCache: vi.fn(),
  useTeamStates: () => ({
    data: [{ id: 'done', name: 'Done', type: 'completed', color: '#888888' }],
    loading: false
  })
}))

vi.mock('@/store/slices/worktrees/listing/use-worktree-catalog', async (original) => {
  const empty: [] = []
  return { ...(await original<Record<string, unknown>>()), useAllWorktrees: () => empty }
})

vi.mock('@/store/workspaces/catalog/workspace-record-fields', async (original) => {
  const empty: [] = []
  return { ...(await original<Record<string, unknown>>()), selectFolderWorkspaces: () => empty }
})

vi.mock('@/components/LinearIssueMarkdownDescriptionEditor', () => ({
  LinearIssueMarkdownDescriptionEditor: () => null
}))

vi.mock('@/components/linear-item-drawer-sheet', () => ({
  renderLinearItemDrawerSheet: (props: {
    displayed: LinearIssue | null
    editState: LinearEditState | null
  }) =>
    props.displayed && props.editState ? (
      <DrawerFields row={props.displayed} editState={props.editState} />
    ) : (
      <div />
    )
}))

export function DrawerFields({ row, editState }: { row: LinearIssue; editState: LinearEditState }) {
  const controller = useLinearIssueEditController({ issue: row, editState })
  return (
    <>
      <output data-testid="drawer">
        {row.state.name}:{editState.priority}:{editState.labels.join(',')}
      </output>
      <button onClick={() => controller.handlePriorityChange('4')}>Priority</button>
      <button onClick={() => controller.handleLabelToggle('bug')}>Label</button>
      <LinearIssueTextEditor issue={row} fields="title" />
    </>
  )
}

export function task(state = 'In Review') {
  return {
    ...issue('same-uuid'),
    identifier: 'DAT-124',
    workspaceId: 'w',
    state: { name: state, type: state === 'Done' ? 'completed' : 'started', color: '#888888' }
  }
}

export function store() {
  const result = createTestStore()
  result.setState({
    linearStatus: { connected: true, viewer: accountViewer, selectedWorkspaceId: 'w' },
    linearStatusObserved: true,
    linearStatusChecked: true,
    linearStatusContextKey: getLinearSourceScope(defaultScopeSource(null)).runtimeContextKey
  })
  active.store.mockReturnValue(result)
  return result
}

export type Store = ReturnType<typeof store>

beforeEach(() => {
  deferredIssueSetters.enabled = false
  deferredIssueSetters.updates.length = 0
  vi.resetAllMocks()
  reads.connect.mockResolvedValue({ ok: true, viewer: accountViewer })
  reads.test.mockResolvedValue({ ok: true, viewer: accountViewer })
  clearLinearRequestMaps()
})

afterEach(() => {
  cleanup()
  clearLinearRequestMaps()
})

export { reads }
