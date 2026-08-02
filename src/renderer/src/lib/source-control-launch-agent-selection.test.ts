import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings, Repo, TuiAgent } from '../../../shared/types'
import {
  resolveSourceControlLaunchAgentScope,
  summarizeReposOverridingActionRecipe
} from './source-control-launch-agent-selection'

function settingsWithGlobalResolveAgent(agentId: TuiAgent): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: agentId,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      actions: {
        ...base.sourceControlAi!.actions,
        resolveConflicts: { agentId, commandInputTemplate: '{basePrompt}', agentArgs: '' }
      }
    }
  }
}

function repoWithResolveAgent(agentId: TuiAgent): Pick<Repo, 'sourceControlAi'> {
  return {
    sourceControlAi: {
      actionOverrides: {
        resolveConflicts: { agentId, commandInputTemplate: '{basePrompt}', agentArgs: '' }
      }
    }
  }
}

describe('resolveSourceControlLaunchAgentScope', () => {
  it('flags a repo override that pins a different agent than the global default', () => {
    const scope = resolveSourceControlLaunchAgentScope({
      settings: settingsWithGlobalResolveAgent('claude'),
      repo: repoWithResolveAgent('codex'),
      actionId: 'resolveConflicts'
    })
    expect(scope).toEqual({
      effectiveAgentId: 'codex',
      globalAgentId: 'claude',
      overridesGlobalAgent: true
    })
  })

  it('does not flag a repo override that matches the global agent', () => {
    const scope = resolveSourceControlLaunchAgentScope({
      settings: settingsWithGlobalResolveAgent('claude'),
      repo: repoWithResolveAgent('claude'),
      actionId: 'resolveConflicts'
    })
    expect(scope.overridesGlobalAgent).toBe(false)
  })

  it('does not flag when there is no repo override', () => {
    const scope = resolveSourceControlLaunchAgentScope({
      settings: settingsWithGlobalResolveAgent('claude'),
      repo: null,
      actionId: 'resolveConflicts'
    })
    expect(scope).toEqual({
      effectiveAgentId: 'claude',
      globalAgentId: 'claude',
      overridesGlobalAgent: false
    })
  })

  it('falls back to the default agent when no global recipe agent is set', () => {
    const base = getDefaultSettings('/tmp')
    const settings: GlobalSettings = {
      ...base,
      defaultTuiAgent: 'claude',
      sourceControlAi: { ...base.sourceControlAi!, enabled: true }
    }
    const scope = resolveSourceControlLaunchAgentScope({
      settings,
      repo: repoWithResolveAgent('codex'),
      actionId: 'resolveConflicts'
    })
    expect(scope.globalAgentId).toBe('claude')
    expect(scope.overridesGlobalAgent).toBe(true)
  })
})

function repoOverriding(
  id: string,
  displayName: string,
  agentId: TuiAgent
): Pick<Repo, 'id' | 'displayName' | 'sourceControlAi'> {
  return { id, displayName, ...repoWithResolveAgent(agentId) }
}

describe('summarizeReposOverridingActionRecipe', () => {
  it('lists repos with any action recipe override', () => {
    const summary = summarizeReposOverridingActionRecipe({
      repos: [
        repoOverriding('repo-1', 'App', 'claude'),
        {
          id: 'repo-2',
          displayName: 'Web',
          sourceControlAi: {
            actionOverrides: {
              resolveConflicts: {
                commandInputTemplate: '{basePrompt}\n\nUse project conflict rules.',
                agentArgs: '--model gpt-5.4-mini'
              }
            }
          }
        },
        { id: 'repo-3', displayName: 'Docs' }
      ],
      actionId: 'resolveConflicts'
    })

    expect(summary).toEqual({
      count: 2,
      overrides: [
        { repoId: 'repo-1', repoName: 'App', fields: ['agent', 'commandTemplate', 'agentArgs'] },
        { repoId: 'repo-2', repoName: 'Web', fields: ['commandTemplate', 'agentArgs'] }
      ]
    })
  })

  it('includes legacy repo instructions as command template overrides', () => {
    const summary = summarizeReposOverridingActionRecipe({
      repos: [
        {
          id: 'repo-1',
          displayName: 'App',
          sourceControlAi: {
            instructionsByOperation: {
              commitMessage: 'Use project style.'
            }
          }
        }
      ],
      actionId: 'commitMessage'
    })

    expect(summary).toEqual({
      count: 1,
      overrides: [{ repoId: 'repo-1', repoName: 'App', fields: ['commandTemplate'] }]
    })
  })
})
