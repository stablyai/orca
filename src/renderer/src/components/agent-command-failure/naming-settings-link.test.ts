import { describe, expect, it } from 'vitest'
import {
  branchNamingSettingsTarget,
  canOpenNamingSettings,
  isTransientNamingFailure
} from './naming-settings-link'
import type { Repo } from '../../../../shared/repository/repo-types'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'

const WORKTREE_ID = 'repo1::/path/wt1'

type TargetRepo = Pick<Repo, 'id' | 'displayName' | 'kind' | 'sourceControlAi'>

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
      branchNamingSettingsTarget({ worktreeId: WORKTREE_ID, settings: null, repos: [repo()] })
    ).toEqual({ pane: 'git', repoId: null, sectionId: 'source-control-ai-action-branchName' })
  })

  it("opens the repo's Branch name row when the repo overrides that recipe", () => {
    expect(
      branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
        settings: null,
        repos: [overridingRepo()]
      })
    ).toEqual({
      pane: 'repo',
      repoId: 'repo1',
      sectionId: 'repo-repo1-source-control-ai-branchName'
    })
  })

  it('opens the global row for a folder workspace, which has no repo row', () => {
    expect(
      branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
        settings: null,
        repos: [overridingRepo('folder')]
      })
    ).toEqual({ pane: 'git', repoId: null, sectionId: 'source-control-ai-action-branchName' })
  })

  it('opens the Source Control AI group when its recipes are hidden', () => {
    expect(
      branchNamingSettingsTarget({
        worktreeId: WORKTREE_ID,
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
