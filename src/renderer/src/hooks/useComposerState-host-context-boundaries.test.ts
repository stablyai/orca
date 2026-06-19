import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canResolveFolderSmartGitHubSubmit,
  resolveInitialWorkspaceRunSeed
} from './useComposerState'

const HOOK_SOURCE = readFileSync(join(__dirname, 'useComposerState.ts'), 'utf8')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('useComposerState host-context boundaries', () => {
  it('resolves GitHub PR bases against the selected run repo, not the source item repo', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleSmartGitHubItemSelect',
      'const handleSmartGitLabItemSelect'
    )

    expect(section).toContain('const runRepo = selectedRepo ??')
    expect(section).toContain('resolveGitHubPrStartPointForRepo')
    expect(section).toContain('repoId: runRepo.id')
    expect(section).toContain('settings: itemRepoSettings')
    expect(section).not.toContain('repoId: repoForItem.id')
    expect(section).not.toContain('repo: repoForItem.id')
  })

  it('resolves GitLab MR bases against the selected run repo, not the source item repo', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleSmartGitLabItemSelect',
      'const handleSmartBranchSelect'
    )

    expect(section).toContain('const runRepo = selectedRepo ??')
    expect(section).toContain('repoId: runRepo.id')
    expect(section).toContain('getSettingsForRepoRuntimeOwner')
    expect(section).toContain('worktree.resolveMrBase')
    expect(section).toContain('repo: runRepo.id')
    expect(section).not.toContain('repoId: repoForItem.id')
  })

  it('does not use local SSH gates for runtime-owned folder targets', () => {
    const targetSection = sourceBetween(
      HOOK_SOURCE,
      'const parsedFolderTargetHost',
      'const selectedWorkspaceTarget'
    )
    expect(targetSection).toContain("parsedFolderTargetHost?.kind === 'runtime'")
    expect(targetSection).toContain('connectionId: folderTargetConnectionId')
    expect(HOOK_SOURCE).not.toContain('folderSourceConnectionId')
  })

  it('routes folder target runtime ownership through detection, path status, and create', () => {
    const targetSection = sourceBetween(
      HOOK_SOURCE,
      'const parsedFolderTargetHost',
      'const selectedWorkspaceTarget'
    )
    expect(targetSection).toContain('folderTargetRuntimeEnvironmentId')
    expect(targetSection).toContain("{ kind: 'runtime' as const")
    expect(targetSection).toContain('useFolderWorkspaceComposerPathStatus(')
    expect(targetSection).toContain('folderTargetRuntimeEnvironmentId')
    expect(targetSection).toContain('useDetectedAgents(folderTargetAgentDetectionTarget)')

    const submitSection = sourceBetween(
      HOOK_SOURCE,
      'const submitFolderTarget',
      'const submit = useCallback'
    )
    expect(submitSection).toContain('isRemote: folderTargetIsRemote')
    expect(submitSection).toContain(
      "launchSource: telemetrySource === 'onboarding' ? 'onboarding' : 'new_workspace_composer'"
    )
    expect(submitSection).toContain('runtimeEnvironmentId: folderTargetRuntimeEnvironmentId')
  })

  it('seeds initial workspace run target from the task source context', () => {
    expect(
      resolveInitialWorkspaceRunSeed({
        initialTaskSourceContext: {
          projectId: 'logical-project',
          hostId: 'ssh:builder',
          projectHostSetupId: 'setup-builder'
        }
      })
    ).toEqual({
      projectId: 'logical-project',
      hostId: 'ssh:builder',
      projectHostSetupId: 'setup-builder'
    })

    expect(
      resolveInitialWorkspaceRunSeed({
        draftProjectId: 'draft-project',
        draftHostId: 'local',
        draftProjectHostSetupId: 'setup-local',
        initialTaskSourceContext: {
          projectId: 'logical-project',
          hostId: 'ssh:builder',
          projectHostSetupId: 'setup-builder'
        }
      })
    ).toEqual({
      projectId: 'draft-project',
      hostId: 'local',
      projectHostSetupId: 'setup-local'
    })

    const section = sourceBetween(HOOK_SOURCE, 'const initialRunSeed', 'const [internalRepoId')

    expect(section).toContain('resolveInitialWorkspaceRunSeed')
    expect(section).toContain('initialTaskSourceContext')
    expect(section).toContain('projectId: initialRunSeed.projectId')
    expect(section).toContain('hostId: initialRunSeed.hostId')
    expect(section).toContain('projectHostSetupId: initialRunSeed.projectHostSetupId')
  })

  it('resolves typed GitHub issue/PR input through the selected repo source context', () => {
    expect(HOOK_SOURCE).toContain('const selectedRepoGitHubSourceContext = useMemo')

    const directLookup = sourceBetween(
      HOOK_SOURCE,
      'void window.api.gh',
      'const applyLinkedWorkItem = useCallback'
    )
    expect(directLookup).toContain('sourceContext: selectedRepoGitHubSourceContext')

    const submitLookup = sourceBetween(
      HOOK_SOURCE,
      'const resolvePendingSmartGitHubSubmit',
      'const prStartPoint'
    )
    expect(submitLookup).toContain('sourceContext:')
    expect(submitLookup).toContain('selectedRepoGitHubSourceContext')
  })

  it('uses submit-time GitHub PR start points for the create payload', () => {
    const submitLookup = sourceBetween(
      HOOK_SOURCE,
      'const resolvePendingSmartGitHubSubmit',
      'const applyLinkedGitLabWorkItem'
    )
    expect(submitLookup).toContain('resolveGitHubPrStartPointForRepo')
    expect(submitLookup).toContain("kind: 'pr-start-point'")
    expect(submitLookup).toContain("kind: 'metadata-only'")
    expect(submitLookup).toContain('baseBranch: prStartPoint.baseBranch')
    expect(submitLookup).toContain('branchNameOverride: prStartPoint.branchNameOverride')

    const fullSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submit = useCallback',
      'const submitQuick = useCallback'
    )
    expect(fullSubmit).toContain("smartGitHubResolution.kind === 'pr-start-point'")
    expect(fullSubmit).toContain("smartGitHubResolution.kind === 'metadata-only'")
    expect(fullSubmit).toContain('effectiveLinkedPR !== null || linkedGitLabMR !== null')
    expect(fullSubmit).toContain('selectedRepoIsGit ? submitBaseBranch : undefined')
    expect(fullSubmit).toContain('submitPushTarget')
    expect(fullSubmit).toContain('submitCompareBaseRef')
    expect(fullSubmit).not.toContain('smartGitHubResolution?.baseBranch ?? baseBranch')
    expect(fullSubmit).not.toContain('smartGitHubResolution?.compareBaseRef ?? compareBaseRef')
    expect(fullSubmit).not.toContain('smartGitHubResolution?.pushTarget ?? pushTarget')
    expect(fullSubmit).not.toContain(
      'smartGitHubResolution?.branchNameOverride ?? branchNameOverride'
    )

    const quickSubmit = sourceBetween(HOOK_SOURCE, 'const submitQuick = useCallback', 'return {')
    expect(quickSubmit).toContain("smartGitHubResolution.kind === 'pr-start-point'")
    expect(quickSubmit).toContain("smartGitHubResolution.kind === 'metadata-only'")
    expect(quickSubmit).toContain('effectiveLinkedPR !== null || linkedGitLabMR !== null')
    expect(quickSubmit).toContain('explicitBaseBranch: smartSubmitBaseBranch')
    expect(quickSubmit).toContain('pushTarget: submitPushTarget')
    expect(quickSubmit).toContain('compareBaseRef: submitCompareBaseRef')
    expect(quickSubmit).not.toContain('smartGitHubResolution?.baseBranch ?? baseBranch')
    expect(quickSubmit).not.toContain('smartGitHubResolution?.compareBaseRef ?? compareBaseRef')
    expect(quickSubmit).not.toContain('smartGitHubResolution?.pushTarget ?? pushTarget')
    expect(quickSubmit).not.toContain(
      'smartGitHubResolution?.branchNameOverride ?? branchNameOverride'
    )
  })

  it('resolves submit-time GitHub smart input when folder child repos exist', () => {
    expect(
      canResolveFolderSmartGitHubSubmit({
        hasFolderSourceRepos: true
      })
    ).toBe(true)
    expect(
      canResolveFolderSmartGitHubSubmit({
        hasFolderSourceRepos: false
      })
    ).toBe(false)

    const lookupSection = sourceBetween(
      HOOK_SOURCE,
      'const resolvePendingSmartGitHubSubmit',
      'const prStartPoint'
    )
    expect(lookupSection).toContain('isProjectGroupTarget')
    expect(lookupSection).toContain('folderSourceRepos.filter(isGitRepoKind)')
    expect(lookupSection).toContain('Promise.all')
    expect(lookupSection).toContain('buildTaskSourceContextFromRepo')

    const section = sourceBetween(
      HOOK_SOURCE,
      'const submitFolderTarget',
      'const submit = useCallback'
    )
    expect(section).toContain('canResolveFolderSmartGitHubSubmit')
    expect(section).toContain('hasFolderSourceRepos: folderSourceRepos.length > 0')
    expect(section).toContain('? await resolvePendingSmartGitHubSubmit()')
    expect(section).toContain(': null')
    expect(section).not.toContain('folderSourceRequiresConnection')
  })

  it('forces repo-scoped source reset when returning from folder target to a repo with the same id', () => {
    const handleRepoChange = sourceBetween(
      HOOK_SOURCE,
      'const handleRepoChange = useCallback',
      'const handleFolderSourceRepoChange = useCallback'
    )
    expect(handleRepoChange).toContain('forceResetStartFrom?: boolean')
    expect(handleRepoChange).toContain('value === repoId && !options.forceResetStartFrom')

    const handleProjectChange = sourceBetween(
      HOOK_SOURCE,
      'const handleProjectChange = useCallback',
      'const handleSmartGitHubItemSelect'
    )
    expect(handleProjectChange).toContain(
      'handleRepoChange(nextRepoId, { forceResetStartFrom: isProjectGroupTarget })'
    )
  })

  it('clears GitLab-specific linked state when clearing smart-name selection', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleClearSmartNameSelection = useCallback',
      'const submitFolderTarget = useCallback'
    )
    expect(section).toContain("setLinkedIssue('')")
    expect(section).toContain('setLinkedPR(null)')
    expect(section).toContain('setLinkedGitLabIssue(null)')
    expect(section).toContain('setLinkedGitLabMR(null)')
    expect(section).toContain('setLinkedWorkItem(null)')
  })

  it('clears stale opposite-provider review fields when selecting linked work items', () => {
    const githubApply = sourceBetween(
      HOOK_SOURCE,
      'const applyLinkedWorkItem = useCallback',
      'const resolvePendingSmartGitHubSubmit'
    )
    expect(githubApply).toContain('setLinkedGitLabIssue(null)')
    expect(githubApply).toContain('setLinkedGitLabMR(null)')

    const gitlabApply = sourceBetween(
      HOOK_SOURCE,
      'const applyLinkedGitLabWorkItem = useCallback',
      'const handleSelectLinkedItem'
    )
    expect(gitlabApply).toContain("setLinkedIssue('')")
    expect(gitlabApply).toContain('setLinkedPR(null)')

    const projectGroupSmartHandlers = sourceBetween(
      HOOK_SOURCE,
      'const handleSmartGitHubItemSelect',
      'const handleSmartBranchSelect'
    )
    expect(projectGroupSmartHandlers).toContain('setLinkedGitLabIssue(null)')
    expect(projectGroupSmartHandlers).toContain('setLinkedGitLabMR(null)')
    expect(projectGroupSmartHandlers).toContain("setLinkedIssue('')")
    expect(projectGroupSmartHandlers).toContain('setLinkedPR(null)')
  })

  it('disables repo-backed folder smart lookup when a folder target has no source repos', () => {
    const cardProps = sourceBetween(
      HOOK_SOURCE,
      'const cardProps: ComposerCardProps = {',
      'return {'
    )
    expect(cardProps).toContain(
      'repoBackedSourcesDisabled: isProjectGroupTarget ? folderSourceRepos.length === 0 : false'
    )
    expect(cardProps).toContain(
      'repoBackedSearchRepos: isProjectGroupTarget ? folderSourceRepos : undefined'
    )
  })

  it('surfaces folder submit smart-resolution failures through create error UI', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const submitFolderTarget',
      'const submit = useCallback'
    )
    expect(section).toContain('catch (error)')
    expect(section).toContain('const formattedError = formatWorkspaceCreateError(error)')
    expect(section).toContain('setCreateError(formattedError)')
    expect(section).toContain('toast.error(getWorkspaceCreateErrorToastMessage(formattedError))')
    expect(section).toContain('if (!folderWorkspaceCreated)')
    expect(section).toContain('setCreateError({')
  })

  it('passes folder child repos to smart lookup instead of building task source options', () => {
    const cardProps = sourceBetween(
      HOOK_SOURCE,
      'const cardProps: ComposerCardProps = {',
      'return {'
    )
    expect(cardProps).toContain(
      'repoBackedSearchRepos: isProjectGroupTarget ? folderSourceRepos : undefined'
    )
    expect(HOOK_SOURCE).not.toContain('folderSourceProjectOptions')
    expect(HOOK_SOURCE).not.toContain('handleFolderTaskSourceProjectChange')
    expect(HOOK_SOURCE).not.toContain('getRepoIdFromNewWorkspaceFolderSourceOptionId')
  })

  it('keeps folder run repo changes inside the selected folder source set', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleFolderSourceRepoChange = useCallback',
      'const handleProjectHostSetupChange = useCallback'
    )
    expect(section).toContain('folderSourceRepos.some((repo) => repo.id === value)')
    expect(section).toContain('return')

    const cardProps = sourceBetween(
      HOOK_SOURCE,
      'const cardProps: ComposerCardProps = {',
      'return {'
    )
    expect(cardProps).toContain('allowSmartNameAddProject: !isProjectGroupTarget')
  })

  it('preserves Jira linked items when switching from repo target to folder target', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const handleProjectChange = useCallback',
      'const handleSmartGitHubItemSelect'
    )
    expect(section).toContain("linkedProvider !== 'linear' && linkedProvider !== 'jira'")
  })

  it('resolves quick-create base refs through the worktree-create precedence helper', () => {
    const section = sourceBetween(
      HOOK_SOURCE,
      'const smartSubmitBaseBranch',
      'const createDisplayName'
    )

    expect(section).toContain('resolveWorktreeCreateBaseBranch')
    expect(section).toContain('explicitBaseBranch: smartSubmitBaseBranch')
    expect(section).toContain('repoWorktreeBaseRef: selectedRepo.worktreeBaseRef')
    expect(section).toContain('getRuntimeRepoBaseRefDefault')
  })

  it('plans new workspace agent startup from the selected repo runtime', () => {
    expect(HOOK_SOURCE).toContain('const selectedRepoAgentLaunchPlatform = useMemo')
    expect(HOOK_SOURCE).toContain('getLocalRepoProjectExecutionRuntimeContext')
    expect(HOOK_SOURCE).toContain('getAgentLaunchPlatformForRepo(selectedRepo, projectRuntime)')

    const fullSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submit = useCallback',
      'const submitQuick = useCallback'
    )
    expect(fullSubmit).toContain('platform: selectedRepoAgentLaunchPlatform')
    expect(fullSubmit).not.toContain('platform: CLIENT_PLATFORM')

    const quickSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submitQuick = useCallback',
      'const createGateInput'
    )
    expect(quickSubmit).toContain('platform: selectedRepoAgentLaunchPlatform')
    expect(quickSubmit).not.toContain('platform: CLIENT_PLATFORM')
  })

  it('prepares linked quick-create drafts for the selected default agent', () => {
    const quickSubmit = sourceBetween(
      HOOK_SOURCE,
      'const submitQuick = useCallback',
      'const createGateInput'
    )

    expect(quickSubmit).toContain(
      'const promptLinkedWorkItem = agent === null ? null : submitLinkedWorkItem'
    )
    expect(quickSubmit).toContain('resolveQuickCreateLinkedWorkItemPrompt(promptLinkedWorkItem')
    expect(quickSubmit).not.toContain('explicitAgentChoice')
    expect(quickSubmit).not.toContain('shouldPrepareQuickLinkedWorkItemAgentPrompt')
    expect(HOOK_SOURCE).not.toContain('resolveQuickWorkspaceSubmitAgent')
  })
})
