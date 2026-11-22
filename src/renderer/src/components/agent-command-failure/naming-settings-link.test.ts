import { describe, expect, it } from 'vitest'
import { branchNamingSettingsTarget } from './naming-settings-link'
import type { Repo } from '../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { getCommitMessageModelDiscoveryHostKey } from '../../../../shared/source-control/ai/generation/commit-message-host-key'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { resolveSourceControlAiForOperation } from '../../../../shared/source-control/ai/source-control-ai-operation-resolution'

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

// Same id on a paired host, with overrides of its own: choosing it would change every answer.
const pairedTwin = repo({
  executionHostId: 'runtime:env-1',
  sourceControlAi: {
    customAgentCommand: 'twin-namer {prompt}',
    actionOverrides: { branchName: { agentId: 'codex' } }
  }
})

type NamingSettings = ReturnType<typeof agent>

function agent(agentId: 'claude' | 'codex' | 'custom', customAgentCommand = '') {
  return {
    sourceControlAi: {
      ...normalizeSourceControlAiSettings(undefined, undefined),
      agentId,
      customAgentCommand
    }
  }
}

// Main's branch rename reads the workspace host's repo (its store holds no paired twins) through
// resolveCommitMessageSettings(settings, getCommitMessageModelDiscoveryHostKey(null), 'branchName', repo),
// which forwards to this resolver. A null repo is the same run without the repo's settings.
function generationReads(settings: NamingSettings, generationRepo: TargetRepo | null) {
  const resolved = resolveSourceControlAiForOperation({
    settings,
    repo: generationRepo,
    operation: 'branchName',
    discoveryHostKey: getCommitMessageModelDiscoveryHostKey(null)
  })
  if (!resolved.ok) {
    return resolved
  }
  // Built-in agents carry the command along, but the plan only runs it for the custom agent.
  const { customAgentCommand, ...params } = resolved.value.params
  return {
    ...resolved.value,
    params: params.agentId === 'custom' ? { ...params, customAgentCommand } : params
  }
}

function changedParams(a: object, b: object): string[] {
  const left = a as { params?: Record<string, unknown> }
  const right = b as { params?: Record<string, unknown> }
  const keys = new Set([...Object.keys(left.params ?? {}), ...Object.keys(right.params ?? {})])
  return [...keys].filter((key) => left.params?.[key] !== right.params?.[key])
}

describe('branchNamingSettingsTarget agrees with branch-name generation', () => {
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
  const cases = [
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
  ]
  const orders = [
    { order: 'paired twin first', list: (local: TargetRepo) => [pairedTwin, local] },
    { order: 'workspace repo first', list: (local: TargetRepo) => [local, pairedTwin] }
  ]

  it.each(cases.flatMap((c) => orders.map((o) => ({ ...c, ...o }))))(
    '$name, $order: opens the setting the run reads',
    ({ settings, repo: localRepo, expected, list }) => {
      const landed = branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        settings,
        repos: list(localRepo)
      })
      expect(landed).toEqual(expected)

      const withRepo = generationReads(settings, localRepo)
      const withoutRepo = generationReads(settings, null)
      const changed = changedParams(withRepo, withoutRepo)
      const repoGovernsRun = JSON.stringify(withRepo) !== JSON.stringify(withoutRepo)
      expect(landed.pane === 'repo').toBe(repoGovernsRun)
      if (landed.pane === 'repo') {
        // The workspace host's repo, not the twin, and the row for what that repo changed.
        expect([landed.repoId, landed.hostId]).toEqual([
          localRepo.id,
          getRepoExecutionHostId(localRepo)
        ])
        const commandOnly = changed.length === 1 && changed[0] === 'customAgentCommand'
        expect(landed.sectionId === 'repo-repo1-source-control-ai-custom-command').toBe(commandOnly)
      }
    }
  )
})
