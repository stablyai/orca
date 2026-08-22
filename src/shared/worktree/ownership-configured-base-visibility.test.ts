import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../global-settings-types'
import type { Repo } from '../repo-types'
import type { Worktree } from './types'
import { resolveConfiguredWorktreeBasePaths } from './configured-worktree-base-path'
import { createWorktreeVisibilitySourceMatcher } from './visibility-sources'
import {
  buildKnownOrcaWorkspaceLayouts,
  classifyWorktreeOwnership,
  toDetectedWorktree,
  EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT
} from './ownership'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repos/OrbisCXM',
    displayName: 'OrbisCXM',
    badgeColor: '#000',
    addedAt: EXTERNAL_WORKTREE_VISIBILITY_ROLLOUT_AT + 1,
    kind: 'git',
    externalWorktreeVisibility: 'show',
    ...overrides
  }
}

function makeWorktree(path: string): Worktree {
  return {
    id: `repo-1::${path}`,
    repoId: 'repo-1',
    path,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    workspaceStatus: 'todo'
  }
}

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    workspaceDir: '/orca/workspaces',
    nestWorkspaces: true,
    workspaceDirHistory: [],
    ...overrides
  } as GlobalSettings
}

function detect(repo: Repo, path: string, settings = makeSettings()) {
  return toDetectedWorktree({
    repo,
    settings,
    worktree: makeWorktree(path),
    knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
  })
}

describe('a configured worktree base that collides with a built-in visibility source (#15232)', () => {
  const configuredBaseWorktree = '/repos/OrbisCXM/.claude/worktrees/OrbisCXM/squash-migrations'
  const tempScratchpadWorktree = '/tmp/claude/abc/scratchpad/sonda-voter'

  it('classifies a plain git worktree in the configured base as external, not agent scratch', () => {
    const repo = makeRepo({ worktreeBasePath: '.claude/worktrees' })
    const settings = makeSettings()

    expect(
      classifyWorktreeOwnership({
        repo,
        settings,
        worktree: makeWorktree(configuredBaseWorktree),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo)
      })
    ).toBe('external')
  })

  it('shows identically-provenanced worktrees the same way wherever they live', () => {
    const repo = makeRepo({ worktreeBasePath: '.claude/worktrees' })

    expect(detect(repo, tempScratchpadWorktree)).toMatchObject({
      ownership: 'external',
      visible: true
    })
    expect(detect(repo, configuredBaseWorktree)).toMatchObject({
      ownership: 'external',
      visible: true
    })
  })

  it('does not attribute the configured base to the built-in source row', () => {
    const repo = makeRepo({ worktreeBasePath: '.claude/worktrees' })

    expect(detect(repo, configuredBaseWorktree).visibilitySource).toBeUndefined()
  })

  it('hands the configured base to the project external-worktree setting', () => {
    const repo = makeRepo({
      worktreeBasePath: '.claude/worktrees',
      externalWorktreeVisibility: 'hide',
      worktreeVisibilitySourcePreferences: { builtIn: { claude: 'show' } }
    })

    // The built-in source no longer covers this directory, so its preference
    // stops applying here and the ordinary external-worktree policy governs.
    expect(detect(repo, configuredBaseWorktree)).toMatchObject({
      ownership: 'external',
      visible: false
    })
    expect(detect(repo, tempScratchpadWorktree).visible).toBe(false)
  })

  it('still lets the built-in preference govern other checkouts scratch dirs', () => {
    const repo = makeRepo({
      worktreeBasePath: '.claude/worktrees',
      externalWorktreeVisibility: 'hide',
      worktreeVisibilitySourcePreferences: { builtIn: { claude: 'show' } }
    })
    const linkedCheckout = '/orca/workspaces/OrbisCXM/feature-x'
    const settings = makeSettings()

    expect(
      toDetectedWorktree({
        repo,
        settings,
        worktree: makeWorktree(`${linkedCheckout}/.claude/worktrees/agent-a04ccaaa`),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
        worktreeVisibilitySourceMatcher: createWorktreeVisibilitySourceMatcher(
          [repo.path, linkedCheckout],
          [],
          resolveConfiguredWorktreeBasePaths(repo)
        )
      })
    ).toMatchObject({ ownership: 'agent-scratch', visible: true })
  })

  it('resolves a Windows-style configured base against the repo root', () => {
    const repo = makeRepo({
      path: String.raw`F:\GitHub\OrbisCXM`,
      worktreeBasePath: String.raw`.claude\worktrees`
    })

    expect(
      detect(repo, String.raw`f:\github\ORBISCXM\.claude\worktrees\OrbisCXM\squash`)
    ).toMatchObject({
      ownership: 'external',
      visible: true
    })
  })

  it('matches configured bases across Windows UNC casing and separators', () => {
    const repo = makeRepo({
      path: String.raw`\\BuildHost\Share\OrbisCXM`,
      worktreeBasePath: String.raw`.claude\worktrees`
    })

    expect(
      detect(repo, '//buildhost/share/orbiscxm/.claude/worktrees/OrbisCXM/squash')
    ).toMatchObject({ ownership: 'external', visible: true })
  })

  it('resolves a relative configured base on the SSH execution host', () => {
    const repo = makeRepo({
      path: '/remote/OrbisCXM',
      connectionId: 'ssh-1',
      worktreeBasePath: '.claude/worktrees'
    })

    const detected = detect(repo, '/remote/OrbisCXM/.claude/worktrees/review')

    expect(detected).toMatchObject({
      ownership: 'external',
      visible: true
    })
    expect(detected.visibilitySource).toBeUndefined()
  })

  it('resolves an absolute configured base that matches a built-in source', () => {
    const repo = makeRepo({ worktreeBasePath: '/repos/OrbisCXM/.claude/worktrees' })

    expect(detect(repo, configuredBaseWorktree)).toMatchObject({
      ownership: 'external',
      visible: true
    })
  })

  it('keeps the configured base external when workspace nesting is flat', () => {
    const repo = makeRepo({ worktreeBasePath: '.claude/worktrees' })

    expect(
      detect(repo, configuredBaseWorktree, makeSettings({ nestWorkspaces: false }))
    ).toMatchObject({
      ownership: 'external',
      visible: true
    })
  })
})

describe('agent scratch stays hidden for repos that did not configure that base (#9388)', () => {
  const scratchWorktree = '/repos/OrbisCXM/.claude/worktrees/OrbisCXM/agent-a04ccaaa'

  it('hides an unconfigured .claude/worktrees checkout', () => {
    const detected = detect(makeRepo(), scratchWorktree)

    expect(detected).toMatchObject({
      ownership: 'agent-scratch',
      visible: false,
      visibilitySource: { kind: 'built-in', id: 'claude' }
    })
  })

  it('hides it when the configured base points somewhere else', () => {
    const repo = makeRepo({ worktreeBasePath: '../worktrees' })

    expect(detect(repo, scratchWorktree)).toMatchObject({
      ownership: 'agent-scratch',
      visible: false
    })
  })

  it('hides scratch nested under a linked checkout even with a configured base', () => {
    const repo = makeRepo({ worktreeBasePath: '.claude/worktrees' })
    const linkedCheckout = '/orca/workspaces/OrbisCXM/feature-x'
    const settings = makeSettings()

    expect(
      toDetectedWorktree({
        repo,
        settings,
        worktree: makeWorktree(`${linkedCheckout}/.claude/worktrees/agent-a04ccaaa`),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
        worktreeVisibilitySourceMatcher: createWorktreeVisibilitySourceMatcher(
          [repo.path, linkedCheckout],
          [],
          resolveConfiguredWorktreeBasePaths(repo)
        )
      })
    ).toMatchObject({ ownership: 'agent-scratch', visible: false })
  })

  it('hides scratch when the configured base only contains the scratch root', () => {
    for (const worktreeBasePath of ['.', '..', '../worktrees/..']) {
      expect(detect(makeRepo({ worktreeBasePath }), scratchWorktree)).toMatchObject({
        ownership: 'agent-scratch',
        visible: false
      })
    }
  })

  it('exempts only the built-in root the configured base points at', () => {
    const repo = makeRepo({ worktreeBasePath: '.claude/worktrees' })
    const settings = makeSettings()
    // A checkout inside the configured base keeps its own scratch dir hidden.
    const nestedCheckout = '/repos/OrbisCXM/.claude/worktrees/OrbisCXM/nested'

    expect(
      toDetectedWorktree({
        repo,
        settings,
        worktree: makeWorktree(`${nestedCheckout}/.claude/worktrees/agent-a04ccaaa`),
        knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
        worktreeVisibilitySourceMatcher: createWorktreeVisibilitySourceMatcher(
          [repo.path, nestedCheckout],
          [],
          resolveConfiguredWorktreeBasePaths(repo)
        )
      })
    ).toMatchObject({ ownership: 'agent-scratch', visible: false })
  })

  it('hides the other built-in source inside a repo that configured only the claude one', () => {
    const repo = makeRepo({ worktreeBasePath: '.claude/worktrees' })

    expect(detect(repo, '/repos/OrbisCXM/.gsd-workspaces/phase-1')).toMatchObject({
      ownership: 'agent-scratch',
      visible: false
    })
  })
})
