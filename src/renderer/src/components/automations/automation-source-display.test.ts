import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getAutomationSourceDisplay } from './automation-source-display'

describe('automation source display', () => {
  it('summarizes repo-backed source context separately from run location', () => {
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'github',
      hostId: 'ssh:devbox',
      projectId: 'github:stablyai/orca',
      projectHostSetupId: 'setup-devbox',
      repoId: 'repo-devbox',
      accountLabel: 'dev@example.com',
      providerIdentity: {
        provider: 'github',
        owner: 'stablyai',
        repo: 'orca'
      }
    }

    expect(getAutomationSourceDisplay(sourceContext)).toEqual({
      label: 'GitHub · devbox · stablyai/orca',
      title: 'GitHub source · Host: devbox · Account: dev@example.com · Source: stablyai/orca'
    })
  })

  it('uses account identity for Linear sources', () => {
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'linear',
      hostId: 'local',
      projectId: 'repo-1',
      projectHostSetupId: 'setup-local',
      repoId: 'repo-1',
      accountLabel: 'Linear API key',
      providerIdentity: {
        provider: 'linear',
        workspaceId: 'legacy',
        workspaceName: 'Saved Linear workspace'
      }
    }

    expect(getAutomationSourceDisplay(sourceContext)).toEqual({
      label: 'Linear · Local Mac · Saved Linear workspace',
      title:
        'Linear source · Host: Local Mac · Account: Linear API key · Source: Saved Linear workspace'
    })
  })

  it('uses saved remote server labels for runtime-backed sources', () => {
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'github',
      hostId: 'runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3',
      projectId: 'github:stablyai/orca',
      projectHostSetupId: 'setup-runtime',
      repoId: 'repo-runtime',
      providerIdentity: {
        provider: 'github',
        owner: 'stablyai',
        repo: 'orca'
      }
    }

    expect(
      getAutomationSourceDisplay(
        sourceContext,
        new Map([['runtime:03ef704c-b180-4b10-998d-e28fbd5de9a3', 'dev box']])
      )
    ).toEqual({
      label: 'GitHub · dev box · stablyai/orca',
      title: 'GitHub source · Host: dev box · Source: stablyai/orca'
    })
  })

  it('returns null when no source context is saved', () => {
    expect(getAutomationSourceDisplay(null)).toBeNull()
  })
})
