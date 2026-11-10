import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getVisibleAutomationSetupDecision,
  resolveAutomationSetupDecisionForSave
} from './automation-setup-decision'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git',
  hookSettings: {
    mode: 'override',
    setupRunPolicy: 'run-by-default',
    scripts: { setup: 'pnpm install', archive: '' }
  }
}

function setup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-1',
    projectId: 'project-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('automation setup decision defaults', () => {
  it('uses only the selected repo host setup and refuses an ambiguous repo table', () => {
    const remote = { ...repo, connectionId: 'builder' }
    const localSetup = setup({
      hookSettings: {
        mode: 'override',
        setupRunPolicy: 'run-by-default',
        scripts: { setup: 'local setup', archive: '' }
      }
    })
    const remoteSetup = setup({
      hostId: 'ssh:builder',
      hookSettings: {
        mode: 'override',
        setupRunPolicy: 'skip-by-default',
        scripts: { setup: 'remote setup', archive: '' }
      }
    })
    const args = {
      workspaceMode: 'new_per_run' as const,
      repoId: repo.id,
      projectHostSetups: [localSetup, remoteSetup]
    }
    expect(getVisibleAutomationSetupDecision({ ...args, repos: [remote] })).toBe('skip')
    expect(getVisibleAutomationSetupDecision({ ...args, repos: [repo, remote] })).toBeUndefined()
  })

  it('shows setup choice for shared orca.yaml setup and default tabs', () => {
    expect(
      getVisibleAutomationSetupDecision({
        workspaceMode: 'new_per_run',
        repoId: 'repo-1',
        repos: [
          {
            ...repo,
            hookSettings: {
              mode: 'override',
              setupRunPolicy: 'run-by-default',
              scripts: { setup: '', archive: '' }
            }
          }
        ],
        projectHostSetups: [],
        yamlHooks: {
          scripts: { setup: 'pnpm install' },
          defaultTabs: []
        }
      })
    ).toBe('run')

    expect(
      getVisibleAutomationSetupDecision({
        workspaceMode: 'new_per_run',
        repoId: 'repo-1',
        repos: [
          {
            ...repo,
            hookSettings: {
              mode: 'override',
              setupRunPolicy: 'skip-by-default',
              scripts: { setup: '', archive: '' }
            }
          }
        ],
        projectHostSetups: [],
        yamlHooks: {
          scripts: {},
          defaultTabs: [{ title: 'Dev', command: 'pnpm dev' }]
        }
      })
    ).toBe('skip')
  })

  it('fails closed when saving before shared hook inspection is available', () => {
    expect(
      resolveAutomationSetupDecisionForSave({
        workspaceMode: 'new_per_run',
        repoId: 'repo-1',
        repos: [
          {
            ...repo,
            hookSettings: {
              mode: 'override',
              setupRunPolicy: 'run-by-default',
              scripts: { setup: '', archive: '' }
            }
          }
        ],
        projectHostSetups: [],
        draftSetupDecision: undefined
      })
    ).toBe('skip')
  })
})
