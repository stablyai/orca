import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveInitialWorkspaceRunSeed } from './useComposerState'

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
    expect(section).toContain('repoId: runRepo.id')
    expect(section).toContain('repo: runRepo.id')
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
    expect(section).not.toContain('repoId: repoForItem.id')
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
      'const resolution = getSmartGitHubSubmitResolution(item)'
    )
    expect(submitLookup).toContain('sourceContext: selectedRepoGitHubSourceContext')
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
})
