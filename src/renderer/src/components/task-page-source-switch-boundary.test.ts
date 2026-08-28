import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TASK_PAGE_LAYOUT_SOURCE = readFileSync(
  join(__dirname, 'task-page/task-page-layout.tsx'),
  'utf8'
)
const RUNTIME_PREFLIGHT_SOURCE = readFileSync(
  join(__dirname, 'task-page/hooks/use-task-page-runtime-preflight.ts'),
  'utf8'
)
const TASK_PAGE_SOURCE = readFileSync(join(__dirname, 'TaskPage.tsx'), 'utf8')
const USE_ITEM_ACTIONS_SOURCE = readFileSync(
  join(__dirname, 'task-page/hooks/use-task-page-use-item-actions.ts'),
  'utf8'
)
const REPO_SOURCE_CONTEXT_SOURCE = readFileSync(
  join(__dirname, 'task-page/source/repo-source-context.ts'),
  'utf8'
)
const HOST_AVAILABILITY_SOURCE = readFileSync(
  join(__dirname, 'task-page/source/task-source-host-availability.ts'),
  'utf8'
)

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('TaskPage source switching host boundary', () => {
  it('renders GitHub item details from the task-detail page owner only', () => {
    const detailSection = readFileSync(
      join(__dirname, 'task-page/github/github-detail-host.tsx'),
      'utf8'
    )
    const modalSection = sourceBetween(
      TASK_PAGE_LAYOUT_SOURCE,
      '<ProjectViewWrapper selectedRepoIds={repoSelection} />',
      '<GitlabTodosList'
    )

    expect(modalSection).toContain('selectedRepoIds={repoSelection}')
    expect(detailSection).toContain('workItem={dialogWorkItem}')
    expect(detailSection).toContain('<PullRequestPage')
    expect(detailSection).toContain('sourceContext={dialogSourceContext}')
    expect(detailSection).toContain('<GitHubItemDialog')
    expect(detailSection).toContain('sourceContext={dialogSourceContext}')
    expect(modalSection).not.toContain('<GitHubItemDialog')
  })

  it('switches task source without mutating the focused run host', () => {
    const toolbarSource = readFileSync(
      join(__dirname, 'task-page/chrome/task-page-source-toolbar.tsx'),
      'utf8'
    )
    const section = sourceBetween(
      toolbarSource,
      '{visibleSourceOptions.map((source) => {',
      "{taskSource === 'linear' && linearConnected ? ("
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
      HOST_AVAILABILITY_SOURCE,
      'export function getTaskSourceHostAvailabilityForHost',
      "host.health === 'local' || host.health === 'available'"
    )

    expect(section).toContain('TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY')
    expect(section).toContain("reason: 'checking-task-source-capability'")
    expect(section).toContain("reason: 'missing-task-source-capability'")
  })

  it('checks runtime-owned provider auth on the owning runtime', () => {
    const section = sourceBetween(
      RUNTIME_PREFLIGHT_SOURCE,
      'const runtimeTaskSourceHostIds = useMemo(() => {',
      'const getTaskPickerRepoHostLabel = useCallback('
    )

    expect(section).toContain('TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY')
    expect(section).toContain("'preflight.check'")
    expect(section).toContain("{ kind: 'environment', environmentId: parsed.environmentId }")
    expect(RUNTIME_PREFLIGHT_SOURCE).toContain('runtimePreflightStatusByHostId')
  })

  it('preserves exact GitLab project identity when opening or starting from an item', () => {
    const sourceContextBuilder = sourceBetween(
      REPO_SOURCE_CONTEXT_SOURCE,
      'export function getTaskPageRepoSourceContext',
      'export function getTaskPageRepoCacheInput'
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
      USE_ITEM_ACTIONS_SOURCE,
      'const openComposerForGitLabItem = useCallback(',
      'const handleUseGitLabItem = useCallback('
    )
    expect(startGitLabWorkspace).toContain('item.projectRef')
  })
})
