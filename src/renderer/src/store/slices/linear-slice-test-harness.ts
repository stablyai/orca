import {
  openLinearIssueRead,
  type LinearIssueData,
  type LinearIssueRead
} from './linear/linear-issue-publication'
import { getLinearSourceScope } from './linear/linear-slice-scope'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { AppState } from '../types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearProjectSummary } from '../../../../shared/linear/project-types'
import { createLinearSlice } from './linear'
import { createTaskCreationDraftsSlice } from './task-creation-drafts'
import type { LinearSlice } from './linear/linear-slice-contract'

type IssueReadAction =
  | 'fetchLinearIssue'
  | 'refreshLinearIssue'
  | 'searchLinearIssues'
  | 'listLinearIssues'
  | 'listLinearProjectIssues'
  | 'listLinearCustomViewIssues'
type AwaitableRead<T> = LinearIssueRead<T> & PromiseLike<T | null>
type TestAppState = Omit<AppState, IssueReadAction> & {
  [K in IssueReadAction]: AppState[K] extends (...args: infer A) => LinearIssueRead<infer T>
    ? (...args: A) => AwaitableRead<T>
    : never
}

export async function readLinearIssueForTest<T>(read: LinearIssueRead<T>): Promise<T | null> {
  const lease = read.acquire()
  try {
    const view = await lease.waitForCurrentTerminal()
    if (view.kind === 'error') {
      throw view.error
    }
    if (view.kind !== 'data') {
      throw new Error('Linear read abandoned')
    }
    return view.data
  } finally {
    lease.release()
  }
}

function awaitableRead<T>(read: LinearIssueRead<T>): AwaitableRead<T> {
  return {
    acquire: read.acquire,
    // oxlint-disable-next-line unicorn/no-thenable -- Why: test-only awaits acquire and release the real owned read.
    then: (resolve, reject) => readLinearIssueForTest(read).then(resolve, reject)
  }
}

export function createTestStore() {
  const store = create<AppState>()((...a) => {
    const slice = createLinearSlice(...a)
    const state = {
      settings: null,
      ...slice,
      ...createTaskCreationDraftsSlice(...a),
      fetchLinearIssue: (...args) => awaitableRead(slice.fetchLinearIssue(...args)),
      refreshLinearIssue: (...args) => awaitableRead(slice.refreshLinearIssue(...args)),
      searchLinearIssues: (...args) => awaitableRead(slice.searchLinearIssues(...args)),
      listLinearIssues: (...args) => awaitableRead(slice.listLinearIssues(...args)),
      listLinearProjectIssues: (...args) => awaitableRead(slice.listLinearProjectIssues(...args)),
      listLinearCustomViewIssues: (...args) =>
        awaitableRead(slice.listLinearCustomViewIssues(...args))
    } satisfies Pick<TestAppState, 'settings' | keyof LinearSlice>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the checked real Linear slice above is the fixture's complete installed state; unrelated AppState services are intentionally absent.
    return state as unknown as AppState
  })
  // SAFETY: each issue action above is decorated with acquire plus the test-only then adapter.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture installs the real Linear slice only; awaitable decoration preserves each acquire/release contract while unrelated AppState services are absent.
  return store as unknown as UseBoundStore<StoreApi<TestAppState>>
}

export function issue(id: string): LinearIssue {
  return {
    id,
    identifier: id,
    title: id,
    url: `https://linear.app/${id}`,
    state: { name: 'Todo', type: 'unstarted', color: '#888888' },
    team: { id: 'team-1', name: 'Team', key: 'TM' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

export function project(id: string): LinearProjectSummary {
  return { id, name: id, workspaceId: 'workspace-1', workspaceName: 'Workspace' }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

export function linearIssueReadFixture<T extends LinearIssueData>(
  dispatch: () => Promise<T>
): LinearIssueRead<T> {
  return openLinearIssueRead<T>({
    scope: getLinearSourceScope({ kind: 'local' }),
    seed: null,
    dispatch,
    publish: () => {},
    isCurrent: () => true,
    remove: () => {}
  })
}
