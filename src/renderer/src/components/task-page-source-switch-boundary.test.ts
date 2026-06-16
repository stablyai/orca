import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TASK_PAGE_SOURCE = readFileSync(join(__dirname, 'TaskPage.tsx'), 'utf8')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('TaskPage source switching host boundary', () => {
  it('renders GitHub item details from the task-detail page owner only', () => {
    const detailSection = sourceBetween(
      TASK_PAGE_SOURCE,
      "{taskSource === 'github' && dialogWorkItem ?",
      ") : taskSource === 'github' && githubMode === 'project' ?"
    )
    const modalSection = sourceBetween(
      TASK_PAGE_SOURCE,
      '<Dialog\n        open={newJiraIssueOpen}',
      '<GitLabItemDialog'
    )

    expect(detailSection).toContain('<GitHubItemDialog')
    expect(detailSection).toContain('sourceContext={dialogSourceContext}')
    expect(modalSection).not.toContain('<GitHubItemDialog')
  })

  it('switches task source without mutating the focused run host', () => {
    const section = sourceBetween(
      TASK_PAGE_SOURCE,
      '{visibleSourceOptions.map((source) => {',
      "{taskSource === 'linear' && linearConnected ?"
    )

    expect(section).toContain('openTaskPage(')
    expect(section).toContain('taskSource: source.id')
    expect(section).toContain('defaultTaskSource: source.id')
    expect(section).not.toContain('activeRuntimeEnvironmentId')
    expect(section).not.toContain('projectHostSetupId')
    expect(section).not.toContain('workspaceRunContext')
  })

  it('treats missing remote task-source capability as source unavailable', () => {
    const section = sourceBetween(
      TASK_PAGE_SOURCE,
      'function getTaskSourceHostAvailabilityForHost',
      'function getTaskPageRepoCacheInput'
    )

    expect(section).toContain('TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY')
    expect(section).toContain("reason: 'checking-task-source-capability'")
    expect(section).toContain("reason: 'missing-task-source-capability'")
  })

  it('checks runtime-owned provider auth on the owning runtime', () => {
    const section = sourceBetween(
      TASK_PAGE_SOURCE,
      'const runtimeTaskSourceHostIds = useMemo(() => {',
      'const getTaskPickerRepoHostLabel = useCallback('
    )

    expect(section).toContain('TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY')
    expect(section).toContain("'preflight.check'")
    expect(section).toContain("{ kind: 'environment', environmentId: parsed.environmentId }")
    expect(TASK_PAGE_SOURCE).toContain('runtimePreflightStatusByHostId')
  })

  it('preserves exact GitLab project identity when opening or starting from an item', () => {
    const sourceContextBuilder = sourceBetween(
      TASK_PAGE_SOURCE,
      'function getTaskPageRepoSourceContext',
      'function getTaskSourceHostAvailabilityForHost'
    )
    expect(sourceContextBuilder).toContain('gitlabProjectRef?: GitLabProjectRef | null')
    expect(sourceContextBuilder).toContain('buildGitLabProviderIdentity(gitlabProjectRef)')

    const openGitLabDetail = sourceBetween(
      TASK_PAGE_SOURCE,
      'const openGitLabDetailPage = useCallback(',
      'const patchTaskPageWorkItemRows = useCallback('
    )
    expect(openGitLabDetail).toContain('item.projectRef')

    const startGitLabWorkspace = sourceBetween(
      TASK_PAGE_SOURCE,
      'const openComposerForGitLabItem = useCallback(',
      'const handleUseGitLabItem = useCallback('
    )
    expect(startGitLabWorkspace).toContain('item.projectRef')
  })
})
