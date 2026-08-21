import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getAutomationSetupDecisionDraftValue,
  getVisibleAutomationSetupDecision,
  resolveAutomationSetupDecisionForSave
} from './automation-setup-decision'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'mcode',
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
    displayName: 'mcode',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('automation setup decision defaults', () => {
  it.each([
    ['run-by-default', 'run'],
    ['skip-by-default', 'skip'],
    ['ask', 'skip']
  ] as const)('maps %s setup policy to %s', (setupRunPolicy, expectedDecision) => {
    expect(
      getVisibleAutomationSetupDecision({
        createTarget: 'mcode',
        workspaceMode: 'new_per_run',
        repoId: 'repo-1',
        repos: [
          {
            ...repo,
            hookSettings: {
              mode: 'override',
              setupRunPolicy,
              scripts: { setup: 'pnpm install', archive: '' }
            }
          }
        ],
        projectHostSetups: [],
        yamlHooks: null
      })
    ).toBe(expectedDecision)
  })

  it('hides setup choice outside MCode new-run automations with setup', () => {
    const baseArgs = {
      repoId: 'repo-1',
      repos: [repo],
      projectHostSetups: [],
      yamlHooks: null
    }

    expect(
      getVisibleAutomationSetupDecision({
        ...baseArgs,
        createTarget: 'mcode',
        workspaceMode: 'existing'
      })
    ).toBeUndefined()
    expect(
      getVisibleAutomationSetupDecision({
        ...baseArgs,
        createTarget: 'hermes',
        workspaceMode: 'new_per_run'
      })
    ).toBeUndefined()
    expect(
      getVisibleAutomationSetupDecision({
        ...baseArgs,
        createTarget: 'mcode',
        workspaceMode: 'new_per_run',
        repos: [
          {
            ...repo,
            hookSettings: { mode: 'override', scripts: { setup: '', archive: '' } }
          }
        ]
      })
    ).toBeUndefined()
  })

  it('uses ready project-host setup hook settings before repo fallback', () => {
    expect(
      getVisibleAutomationSetupDecision({
        createTarget: 'mcode',
        workspaceMode: 'new_per_run',
        repoId: 'repo-1',
        repos: [repo],
        projectHostSetups: [
          setup({
            hookSettings: {
              mode: 'override',
              setupRunPolicy: 'skip-by-default',
              scripts: { setup: 'bun install', archive: '' }
            }
          })
        ],
        yamlHooks: null
      })
    ).toBe('skip')
  })

  it('shows setup choice for shared mcode.yaml setup and default tabs', () => {
    expect(
      getVisibleAutomationSetupDecision({
        createTarget: 'mcode',
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
        createTarget: 'mcode',
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

  it('omits setup decision when no setup source is visible', () => {
    expect(
      resolveAutomationSetupDecisionForSave({
        createTarget: 'mcode',
        workspaceMode: 'new_per_run',
        repoId: 'repo-1',
        repos: [
          {
            ...repo,
            hookSettings: {
              mode: 'override',
              setupRunPolicy: 'ask',
              scripts: { setup: '', archive: '' }
            }
          }
        ],
        projectHostSetups: [],
        yamlHooks: null,
        draftSetupDecision: undefined
      })
    ).toBeUndefined()
    expect(
      resolveAutomationSetupDecisionForSave({
        createTarget: 'mcode',
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
        yamlHooks: null,
        draftSetupDecision: undefined
      })
    ).toBeUndefined()

    expect(
      resolveAutomationSetupDecisionForSave({
        createTarget: 'mcode',
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
        yamlHooks: null,
        draftSetupDecision: undefined
      })
    ).toBeUndefined()
  })

  it('fails closed when saving before shared hook inspection is available', () => {
    expect(
      resolveAutomationSetupDecisionForSave({
        createTarget: 'mcode',
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

  it('loads legacy new-run automations as skip when editing', () => {
    expect(
      getAutomationSetupDecisionDraftValue({
        workspaceMode: 'new_per_run',
        persistedSetupDecision: undefined
      })
    ).toBe('skip')
    expect(
      getAutomationSetupDecisionDraftValue({
        workspaceMode: 'new_per_run',
        persistedSetupDecision: 'run'
      })
    ).toBe('run')
    expect(
      getAutomationSetupDecisionDraftValue({
        workspaceMode: 'existing',
        persistedSetupDecision: undefined
      })
    ).toBeUndefined()
  })
})
