import { selectPendingWorktreeCreationKeys } from '@/components/sidebar/worktree-list/listing/pending-worktree-creation-keys'
import { withWindowCreations } from '@/components/sidebar/worktree-list/listing/window-worktree-creations'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import { describe, expect, it } from 'vitest'
import {
  findPendingLinkedWorkItemCreationId,
  findPendingWorktreeCreationId,
  type PendingWorktreeCreation,
  type WorktreeCreationRequest
} from './workspace/creation/pending-worktree-creation'

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'workspace',
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function pending(
  creationId: string,
  creationRequest: WorktreeCreationRequest
): PendingWorktreeCreation {
  return {
    creationId,
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request: creationRequest
  }
}

describe('findPendingWorktreeCreationId', () => {
  it('matches Windows path spelling while keeping repositories distinct', () => {
    const entry = {
      ...pending('create-1', request()),
      worktreeId: 'repo-1::C:\\workspaces\\feature'
    }
    expect(findPendingWorktreeCreationId({ entry }, 'repo-1::c:/workspaces/feature/')).toBe(
      'create-1'
    )
    expect(findPendingWorktreeCreationId({ entry }, 'repo-2::c:/workspaces/feature/')).toBeNull()
  })
})

describe('findPendingLinkedWorkItemCreationId', () => {
  it('deduplicates the same linked item on the same execution host', () => {
    const existing = request({
      linkedIssue: 42,
      workspaceRunContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'ssh:server',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })

    expect(
      findPendingLinkedWorkItemCreationId(
        { existing: pending('existing', existing) },
        request({
          linkedIssue: 42,
          workspaceRunContext: {
            ...existing.workspaceRunContext!,
            path: '/renamed-repo'
          }
        })
      )
    ).toBe('existing')
  })

  it('keeps the same linked item on different execution hosts distinct', () => {
    const existing = request({
      linkedPR: 77,
      workspaceRunContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'ssh:server-a',
        projectHostSetupId: 'setup-a',
        repoId: 'repo-1',
        path: '/repo'
      }
    })

    expect(
      findPendingLinkedWorkItemCreationId(
        { existing: pending('existing', existing) },
        request({
          linkedPR: 77,
          workspaceRunContext: {
            ...existing.workspaceRunContext!,
            hostId: 'ssh:server-b',
            projectHostSetupId: 'setup-b'
          }
        })
      )
    ).toBeNull()
  })
})

it('keeps visible and hidden window creations host-qualified without flashing hidden feed entries', () => {
  const entry = (creationId: string, loaderVisible: boolean): PendingWorktreeCreation => ({
    creationId,
    loaderVisible,
    phase: 'preparing',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    request: {
      repoId: 'repo with space',
      executionHostId: 'runtime:server',
      name: 'workspace',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    }
  })
  const pending = { visible: entry('visible', true), hidden: entry('hidden', false) }
  const visible = selectPendingWorktreeCreationKeys(pending)
  const hidden = selectPendingWorktreeCreationKeys(pending, 'hidden')
  expect(visible).toEqual(['visible runtime:server\0repo with space'])
  expect(hidden).toEqual(['hidden runtime:server\0repo with space'])
  const domains: SidebarFeedDomains = {
    workspaces: new Map(),
    activity: new Map(),
    review: new Map(),
    creations: new Map([['hidden', { repoId: 'repo with space' }]]),
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(),
    repoIcons: new Map(),
    desktop: null,
    projectCatalog: null,
    retention: null
  }
  const listed = withWindowCreations(domains, visible, new Set(), hidden)
  expect([...listed.creations]).toEqual([['visible', { repoId: 'repo with space' }]])
  expect(domains.creations.has('hidden')).toBe(true)
})
