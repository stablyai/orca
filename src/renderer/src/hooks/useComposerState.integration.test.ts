// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../shared/worktree/naming/retired-name-registry'

import type { Repo } from '../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { normalizeTaskSourceContext } from '../../../shared/work-items/task-source-context'
import { useComposerState } from './useComposerState'

let originalApiDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const preflight = {
    detectAgents: vi.fn<Window['api']['preflight']['detectAgents']>().mockResolvedValue([])
  } satisfies Pick<Window['api']['preflight'], 'detectAgents'>
  const worktrees = {
    listRetiredNames: vi
      .fn<Window['api']['worktrees']['listRetiredNames']>()
      .mockResolvedValue(EMPTY_RETIRED_NAME_REGISTRY)
  } satisfies Pick<Window['api']['worktrees'], 'listRetiredNames'>
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { preflight, worktrees }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('useComposerState integrated lifecycle', () => {
  it('passes the selected runtime repository to the name field when IDs repeat across hosts', () => {
    const localRepo: Repo = {
      id: 'same-id',
      path: '/local',
      displayName: 'Local',
      badgeColor: '',
      addedAt: 0,
      defaultJiraProject: { id: '10', key: 'LOC', name: 'Local', siteId: 'site-a' }
    }
    const runtimeRepo: Repo = {
      ...localRepo,
      path: '/remote',
      executionHostId: 'runtime:remote',
      defaultJiraProject: { id: '20', key: 'REM', name: 'Remote', siteId: 'site-b' }
    }
    const projection = projectHostSetupProjectionFromRepos([localRepo, runtimeRepo])
    useAppStore.setState({
      repos: [localRepo, runtimeRepo],
      projects: [...projection.projects],
      projectHostSetups: projection.setups.map((setup) => ({
        ...setup,
        id: `${setup.hostId}:setup`
      })),
      projectGroups: [],
      newWorkspaceDraft: null,
      worktreesByRepo: {},
      sparsePresetsByRepo: {},
      runtimeEnvironments: [
        {
          id: 'remote',
          name: 'Remote',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'endpoint'
        }
      ]
    })
    const composer = renderHook(() =>
      useComposerState({
        persistDraft: false,
        initialTaskSourceContext: normalizeTaskSourceContext({
          provider: 'jira',
          projectId: 'repo:same-id',
          hostId: 'runtime:remote'
        })
      })
    )
    expect(composer.result.current.cardProps.selectedRepo).toBe(runtimeRepo)
    expect(composer.result.current.cardProps.smartNameJiraSourceContext?.hostId).toBe(
      'runtime:remote'
    )
    composer.unmount()
  })
})
