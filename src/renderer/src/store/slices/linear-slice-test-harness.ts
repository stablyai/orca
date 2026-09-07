import { create } from 'zustand'
import type { AppState } from '../types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { LinearProjectSummary } from '../../../../shared/linear/project-types'
import { createLinearSlice } from './linear'

export function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: null,
        ...createLinearSlice(...a)
      }) as AppState
  )
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
