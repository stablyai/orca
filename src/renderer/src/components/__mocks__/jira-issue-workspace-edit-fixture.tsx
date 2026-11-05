import { useLayoutEffect, useState } from 'react'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { JiraPatchOptions } from '../../store/slices/jira-slice-contract'
import type { AppState } from '../../store/types'
import { getJiraReadIdentity } from '@/store/slices/jira-read-coordination'
import type * as I18n from '@/i18n/i18n'
import type * as RuntimeJiraClient from '@/runtime/runtime-jira-client'
import { TooltipProvider } from '@/components/ui/tooltip'
import JiraIssueWorkspace from '../JiraIssueWorkspace'

const runtimeMocks: {
  jiraAddIssueCommentForTarget: Mock<typeof RuntimeJiraClient.jiraAddIssueCommentForTarget>
  jiraGetIssueForTarget: Mock<typeof RuntimeJiraClient.jiraGetIssueForTarget>
  jiraIssueCommentsForTarget: Mock<typeof RuntimeJiraClient.jiraIssueCommentsForTarget>
  jiraListAssignableUsersForTarget: Mock<typeof RuntimeJiraClient.jiraListAssignableUsersForTarget>
  jiraListPrioritiesForTarget: Mock<typeof RuntimeJiraClient.jiraListPrioritiesForTarget>
  jiraListTransitionsForTarget: Mock<typeof RuntimeJiraClient.jiraListTransitionsForTarget>
  jiraUpdateIssueForTarget: Mock<typeof RuntimeJiraClient.jiraUpdateIssueForTarget>
} = vi.hoisted(() => ({
  jiraAddIssueCommentForTarget: vi.fn<typeof RuntimeJiraClient.jiraAddIssueCommentForTarget>(),
  jiraGetIssueForTarget: vi.fn<typeof RuntimeJiraClient.jiraGetIssueForTarget>(),
  jiraIssueCommentsForTarget: vi.fn<typeof RuntimeJiraClient.jiraIssueCommentsForTarget>(),
  jiraListAssignableUsersForTarget:
    vi.fn<typeof RuntimeJiraClient.jiraListAssignableUsersForTarget>(),
  jiraListPrioritiesForTarget: vi.fn<typeof RuntimeJiraClient.jiraListPrioritiesForTarget>(),
  jiraListTransitionsForTarget: vi.fn<typeof RuntimeJiraClient.jiraListTransitionsForTarget>(),
  jiraUpdateIssueForTarget: vi.fn<typeof RuntimeJiraClient.jiraUpdateIssueForTarget>()
}))

const store = vi.hoisted(() => ({
  readJiraStatus: vi.fn<AppState['readJiraStatus']>(),
  patchJiraIssue:
    vi.fn<(key: string, patch: Partial<JiraIssue>, options?: JiraPatchOptions) => void>()
}))
export const editState: { settings: GlobalSettings | null; serverTitle: string } = {
  settings: null,
  serverTitle: 'Old title'
}

vi.mock('@/runtime/runtime-jira-client', () => runtimeMocks)
vi.mock('@/store', () => ({
  useAppStore: (
    selector: (
      state: Pick<
        AppState,
        | 'settings'
        | 'jiraStatus'
        | 'jiraStatusContextKey'
        | 'jiraConnectionRevisions'
        | 'readJiraStatus'
        | 'patchJiraIssue'
      >
    ) => unknown
  ) =>
    selector({
      settings: editState.settings,
      jiraStatus: { connected: false, viewer: null },
      jiraStatusContextKey: null,
      jiraConnectionRevisions: {},
      readJiraStatus: store.readJiraStatus,
      patchJiraIssue: (key: string, patch: Partial<JiraIssue>, options?: JiraPatchOptions) =>
        store.patchJiraIssue(key, patch, options)
    })
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string, options?: Parameters<typeof I18n.translate>[2]) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, key: string) => String(options?.[key] ?? match))
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

export function jiraIssue(title: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10001',
    key: 'ENG-1',
    siteId: 'site-1',
    title,
    url: 'https://example.atlassian.net/browse/ENG-1',
    project: { id: '1', key: 'ENG', name: 'Engineering' },
    issueType: { id: '1', name: 'Task' },
    status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

export const otherIssue = jiraIssue('Other issue', { id: '10002', key: 'ENG-2' })

let selectIssueImplementation: ((issue: JiraIssue | null) => void) | null = null
let selectSourceImplementation: ((source: TaskSourceContext) => void) | null = null

export function selectIssue(issue: JiraIssue | null): void {
  if (!selectIssueImplementation) {
    throw new Error('Render StoreBackedWorkspace before selecting an issue')
  }
  selectIssueImplementation(issue)
}

export function selectSource(source: TaskSourceContext): void {
  if (!selectSourceImplementation) {
    throw new Error('Render StoreBackedWorkspace before selecting a source')
  }
  selectSourceImplementation(source)
}
export const initialSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'local'
}
export const initialSourceContextKey = getJiraReadIdentity(null, initialSource).contextKey

// Read optimistically patched issues from the store as the task page does, producing new same-issue objects.
export function StoreBackedWorkspace({ initial }: { initial: JiraIssue }): React.JSX.Element {
  const [issue, setIssue] = useState<JiraIssue | null>(initial)
  const [source, setSource] = useState(initialSource)
  store.patchJiraIssue.mockImplementation((key, patch, options) =>
    setIssue((current) =>
      current?.key === key &&
      (options?.siteId == null || current.siteId === options.siteId) &&
      (!options?.sourceContext ||
        getTaskSourceCacheScope(options.sourceContext) === getTaskSourceCacheScope(source))
        ? { ...current, ...patch }
        : current
    )
  )
  useLayoutEffect(() => {
    selectIssueImplementation = setIssue
    selectSourceImplementation = setSource
    return () => {
      selectIssueImplementation = null
      selectSourceImplementation = null
    }
  }, [])
  return (
    <TooltipProvider>
      <JiraIssueWorkspace issue={issue} sourceContext={source} onUse={vi.fn()} onClose={vi.fn()} />
    </TooltipProvider>
  )
}

const pendingRequests = new Set<(error: Error) => void>()

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined
  let reject = (_error: Error): void => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  pendingRequests.add(reject)
  void promise.then(
    () => pendingRequests.delete(reject),
    () => pendingRequests.delete(reject)
  )
  return { promise, resolve }
}

export async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0))
  })
}

export function saveTitle(from: string, to: string): void {
  const input = screen.getByDisplayValue(from)
  fireEvent.change(input, { target: { value: to } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

beforeEach(() => {
  editState.settings = null
  editState.serverTitle = 'Old title'
  store.patchJiraIssue.mockReset()
  store.readJiraStatus.mockReset().mockResolvedValue({ connected: false, viewer: null })
  for (const mock of Object.values(runtimeMocks)) {
    mock.mockReset()
  }
  runtimeMocks.jiraGetIssueForTarget.mockImplementation(async () =>
    jiraIssue(editState.serverTitle)
  )
  runtimeMocks.jiraIssueCommentsForTarget.mockResolvedValue([])
  runtimeMocks.jiraListTransitionsForTarget.mockResolvedValue([])
  runtimeMocks.jiraListPrioritiesForTarget.mockResolvedValue([])
  runtimeMocks.jiraListAssignableUsersForTarget.mockResolvedValue([])
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    for (const reject of pendingRequests) {
      reject(new Error('Test cleanup'))
    }
    await new Promise((done) => setTimeout(done, 0))
  })
})

export { runtimeMocks, store }
