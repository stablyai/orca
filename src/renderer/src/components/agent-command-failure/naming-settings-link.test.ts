import { describe, expect, it } from 'vitest'
import { branchNamingSettingsTarget } from './naming-settings-link'
import type { Repo } from '../../../../shared/repository/repo-types'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'

const WORKTREE_ID = 'repo1::/path/wt1'

type TargetRepo = Pick<
  Repo,
  'id' | 'displayName' | 'kind' | 'sourceControlAi' | 'connectionId' | 'executionHostId'
>

const repo = (overrides: Partial<TargetRepo> = {}): TargetRepo => ({
  id: 'repo1',
  displayName: 'repo1',
  ...overrides
})

// Same id on a paired host, listed first: its (empty) settings must not decide the local run.
const pairedTwin = repo({ executionHostId: 'runtime:env-1' })

describe('branchNamingSettingsTarget agrees with branch-name generation', () => {
  const agent = (agentId: 'claude' | 'codex' | 'custom', customAgentCommand = '') => ({
    sourceControlAi: {
      ...normalizeSourceControlAiSettings(undefined, undefined),
      agentId,
      customAgentCommand
    }
  })
  const repoModelPick = repo({
    sourceControlAi: {
      modelOverridesByOperation: { branchName: { selectedModelByAgent: { claude: 'haiku' } } }
    }
  })
  const repoCommand = repo({ sourceControlAi: { customAgentCommand: 'repo-namer {prompt}' } })
  const globalTarget = {
    pane: 'git',
    repoId: null,
    sectionId: 'source-control-ai-action-branchName'
  }
  const repoBranchTarget = {
    pane: 'repo',
    repoId: 'repo1',
    hostId: 'local',
    sectionId: 'repo-repo1-source-control-ai-branchName'
  }

  it.each([
    {
      name: 'repo command, custom agent',
      settings: agent('custom', 'global-namer {prompt}'),
      repo: repoCommand,
      expected: { ...repoBranchTarget, sectionId: 'repo-repo1-source-control-ai-custom-command' }
    },
    {
      name: 'repo command, claude agent',
      settings: agent('claude'),
      repo: repoCommand,
      expected: globalTarget
    },
    {
      name: 'repo model pick, same agent',
      settings: agent('claude'),
      repo: repoModelPick,
      expected: repoBranchTarget
    },
    {
      name: 'repo model pick, other agent',
      settings: agent('codex'),
      repo: repoModelPick,
      expected: globalTarget
    },
    {
      name: 'repo agent override',
      settings: agent('claude'),
      repo: repo({ sourceControlAi: { actionOverrides: { branchName: { agentId: 'codex' } } } }),
      expected: repoBranchTarget
    },
    { name: 'no repo settings', settings: agent('claude'), repo: repo(), expected: globalTarget }
  ])('$name: opens the scope that governs the run', ({ settings, repo: localRepo, expected }) => {
    expect(
      branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        settings,
        repos: [pairedTwin, localRepo]
      })
    ).toEqual(expected)
  })
})
