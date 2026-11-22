import { describe, expect, it } from 'vitest'
import {
  branchNamingSettingsTarget,
  canOpenNamingSettings,
  isTransientNamingFailure
} from './naming-settings-link'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
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

const overridingRepo = (kind?: Repo['kind']): TargetRepo =>
  repo({
    ...(kind ? { kind } : {}),
    sourceControlAi: { actionOverrides: { branchName: { agentId: 'codex' } } }
  })

describe('branchNamingSettingsTarget', () => {
  it('opens the global Branch name row when the repo has no override', () => {
    expect(
      branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        settings: null,
        repos: [repo()]
      })
    ).toEqual({ pane: 'git', repoId: null, sectionId: 'source-control-ai-action-branchName' })
  })

  it("opens the repo's Branch name row when the repo overrides that recipe", () => {
    expect(
      branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        settings: null,
        repos: [overridingRepo()]
      })
    ).toEqual({
      pane: 'repo',
      repoId: 'repo1',
      hostId: 'local',
      sectionId: 'repo-repo1-source-control-ai-branchName'
    })
  })

  it('opens the global row for a folder workspace, which has no repo row', () => {
    expect(
      branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        settings: null,
        repos: [overridingRepo('folder')]
      })
    ).toEqual({ pane: 'git', repoId: null, sectionId: 'source-control-ai-action-branchName' })
  })

  it('opens the Source Control AI group when its recipes are hidden', () => {
    expect(
      branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        settings: {
          sourceControlAi: {
            ...normalizeSourceControlAiSettings(undefined, undefined),
            enabled: false
          }
        },
        repos: [repo()]
      })
    ).toEqual({ pane: 'git', repoId: null, sectionId: 'source-control-ai-settings' })
  })

  const sourceControlAi = (
    patch: Partial<NonNullable<GlobalSettings['sourceControlAi']>>
  ): NonNullable<GlobalSettings['sourceControlAi']> => ({
    ...normalizeSourceControlAiSettings(undefined, undefined),
    ...patch
  })
  const target = (
    repos: TargetRepo[],
    settings: Parameters<typeof branchNamingSettingsTarget>[0]['settings'] = null,
    executionHostId: ExecutionHostId = 'local'
  ) => branchNamingSettingsTarget({ worktreeId: WORKTREE_ID, executionHostId, settings, repos })

  it("opens the repo's Custom command row when that command is what the run used", () => {
    expect(
      target([repo({ sourceControlAi: { customAgentCommand: 'my-namer {prompt}' } })], {
        sourceControlAi: sourceControlAi({ agentId: 'custom' })
      })
    ).toEqual({
      pane: 'repo',
      repoId: 'repo1',
      hostId: 'local',
      sectionId: 'repo-repo1-source-control-ai-custom-command'
    })
  })

  it('keeps the global row when the repo command is set but another agent runs', () => {
    expect(
      target([repo({ sourceControlAi: { customAgentCommand: 'my-namer {prompt}' } })], {
        sourceControlAi: sourceControlAi({ agentId: 'claude' })
      })
    ).toEqual({ pane: 'git', repoId: null, sectionId: 'source-control-ai-action-branchName' })
  })

  it("opens the repo's Branch name row for a repo model pick for the agent that runs", () => {
    const modelOnly = repo({
      sourceControlAi: {
        modelOverridesByOperation: { branchName: { selectedModelByAgent: { claude: 'haiku' } } }
      }
    })
    const settings = { sourceControlAi: sourceControlAi({ agentId: 'claude' }) }
    expect(target([modelOnly], settings)).toEqual({
      pane: 'repo',
      repoId: 'repo1',
      hostId: 'local',
      sectionId: 'repo-repo1-source-control-ai-branchName'
    })
    // A repo pick for another agent does not apply to this run.
    expect(target([modelOnly], { sourceControlAi: sourceControlAi({ agentId: 'codex' }) })).toEqual(
      { pane: 'git', repoId: null, sectionId: 'source-control-ai-action-branchName' }
    )
  })

  it('picks the repo on the workspace host, whatever the catalog order', () => {
    const local = { ...overridingRepo(), executionHostId: 'local' as const }
    const pairedTwin = repo({ executionHostId: 'runtime:env-1' })
    const localTarget = {
      pane: 'repo',
      repoId: 'repo1',
      hostId: 'local',
      sectionId: 'repo-repo1-source-control-ai-branchName'
    }
    expect(target([pairedTwin, local])).toEqual(localTarget)
    expect(target([local, pairedTwin])).toEqual(localTarget)
    // The twin's workspace follows the twin, which has no override.
    expect(target([local, pairedTwin], null, 'runtime:env-1')).toEqual({
      pane: 'git',
      repoId: null,
      sectionId: 'source-control-ai-action-branchName'
    })
  })
})

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
  const cases = [
    {
      name: 'repo command, custom agent',
      settings: agent('custom', 'g {prompt}'),
      repo: repoCommand
    },
    { name: 'repo command, claude agent', settings: agent('claude'), repo: repoCommand },
    { name: 'repo model pick, same agent', settings: agent('claude'), repo: repoModelPick },
    { name: 'repo model pick, other agent', settings: agent('codex'), repo: repoModelPick },
    { name: 'repo agent override', settings: agent('claude'), repo: overridingRepo() },
    { name: 'no repo settings', settings: agent('claude'), repo: repo() }
  ]

  // Same host key main uses for branch rename; null repo = the run without this repo's settings.
  const run = (settings: (typeof cases)[number]['settings'], target: TargetRepo | null) => {
    const resolved = resolveSourceControlAiForOperation({
      settings,
      repo: target,
      operation: 'branchName',
      discoveryHostKey: 'local'
    })
    if (!resolved.ok) {
      return JSON.stringify(resolved)
    }
    // Built-in agents carry the command along, but the plan only runs it for the custom agent.
    const params = { ...resolved.value.params }
    if (params.agentId !== 'custom') {
      delete params.customAgentCommand
    }
    return JSON.stringify({ ...resolved.value, params })
  }

  it.each(cases)('$name: lands on the repo only when its settings change the run', (c) => {
    const landed = branchNamingSettingsTarget({
      worktreeId: WORKTREE_ID,
      executionHostId: 'local',
      settings: c.settings,
      repos: [c.repo]
    })
    expect(landed.pane === 'repo').toBe(run(c.settings, c.repo) !== run(c.settings, null))
  })
})

describe('isTransientNamingFailure', () => {
  it('treats timeouts and host-side preparation failures as transient', () => {
    expect(isTransientNamingFailure('Generation timed out after 60s.')).toBe(true)
    expect(
      isTransientNamingFailure('Could not check whether the branch is published: exit 128')
    ).toBe(true)
    expect(
      isTransientNamingFailure('Could not prepare the workspace-name generation environment.')
    ).toBe(true)
  })

  it('treats configuration, CLI and unknown failures as fixable in Settings', () => {
    expect(
      isTransientNamingFailure(
        'Choose a supported Source Control AI agent for this action in Settings -> Git -> Source Control AI. Supported agents: Claude, or Custom command.'
      )
    ).toBe(false)
    expect(isTransientNamingFailure('Pi CLI command failed with code 1: No API key found.')).toBe(
      false
    )
    expect(isTransientNamingFailure('')).toBe(false)
  })
})

describe('canOpenNamingSettings', () => {
  it('hides the link for a paired runtime, whose own settings name its work', () => {
    expect(canOpenNamingSettings('runtime:env-1')).toBe(false)
    expect(canOpenNamingSettings('local')).toBe(true)
    expect(canOpenNamingSettings('ssh:box')).toBe(true)
    expect(canOpenNamingSettings(undefined)).toBe(true)
  })
})
