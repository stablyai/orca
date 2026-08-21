import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TASK_PAGE_SOURCE = readFileSync(join(__dirname, 'TaskPage.tsx'), 'utf8')
const PROJECT_VIEW_SOURCE = readFileSync(
  join(__dirname, 'github-project', 'ProjectViewWrapper.tsx'),
  'utf8'
)
const COMPOSER_MODAL_SOURCE = readFileSync(join(__dirname, 'NewWorkspaceComposerModal.tsx'), 'utf8')
const COMPOSER_STATE_SOURCE = readFileSync(join(__dirname, '../hooks/useComposerState.ts'), 'utf8')

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('TaskPage workspace creation source boundaries', () => {
  it('prefills the workspace composer for GitHub issues and pull requests', () => {
    const section = sourceBetween(
      TASK_PAGE_SOURCE,
      'const openComposerForItem = useCallback(',
      'const handleUseWorkItem = useCallback('
    )

    expect(section).toContain("provider: 'github'")
    expect(section).toContain('type: item.type')
    expect(section).toContain('number: item.number')
    expect(section).toContain('title: item.title')
    expect(section).toContain('url: item.url')
    expect(section).toContain("openModal('new-workspace-composer', {")
    expect(section).toContain("getTaskPageRepoSourceContext(repoMap.get(item.repoId), 'github')")
    expect(section).toContain('prefilledName: getGitHubWorkItemWorkspaceSeed(item)')
    expect(section).toContain('initialRepoId: item.repoId')
    expect(section).toContain('initialGitHubWorkItem: item')
    expect(section).toContain("enableIssueAutomation: item.type === 'issue'")
    expect(section).toContain("telemetrySource: 'sidebar'")
  })

  it('forwards PR start-point data and issue automation through quick submit', () => {
    expect(COMPOSER_MODAL_SOURCE).toContain(
      'initialGitHubWorkItem: modalData.initialGitHubWorkItem ?? null'
    )
    expect(COMPOSER_MODAL_SOURCE).toContain(
      'enableIssueAutomation: modalData.enableIssueAutomation === true'
    )
    const quickSubmit = sourceBetween(
      COMPOSER_STATE_SOURCE,
      'const submitQuick = useCallback(',
      'const createGateInput = {'
    )
    expect(quickSubmit).toContain('readAndConfirmRuntimeIssueCommand(')
    expect(quickSubmit).toContain('selectedRepoExecutionHostId')
    expect(quickSubmit).toContain('isSubmissionCancelled')
    expect(quickSubmit).toContain('...(issueCommand ? { issueCommand } : {})')
  })

  it('routes TaskPage GitHub starts directly to the composer', () => {
    const section = sourceBetween(
      TASK_PAGE_SOURCE,
      'const handleUseWorkItem = useCallback(',
      'const handleOpenOrUseGitHubWorkItem = useCallback('
    )

    expect(section).toContain("recordFeatureInteraction('github-tasks')")
    expect(section).toContain('openComposerForItem(item)')
    expect(section).not.toContain('createGitHubWorkItemWorkspaceInBackground')
    expect(TASK_PAGE_SOURCE).not.toContain('@/lib/github-work-item-background-create')
  })

  it('routes TaskPage Linear starts directly to the composer', () => {
    const composerSection = sourceBetween(
      TASK_PAGE_SOURCE,
      'const openComposerForLinearItem = useCallback(',
      'const handleUseLinearItem = useCallback('
    )
    const handlerSection = sourceBetween(
      TASK_PAGE_SOURCE,
      'const handleUseLinearItem = useCallback(',
      'const handleOpenOrUseLinearItem = useCallback('
    )

    expect(composerSection).toContain('buildLinearIssueLinkedWorkItem(issue)')
    expect(composerSection).toContain("openModal('new-workspace-composer', {")
    expect(composerSection).toContain('taskSourceContext: linearTaskSourceContext')
    expect(composerSection).toContain('prefilledName: getLinearIssueWorkspaceName(issue)')
    expect(composerSection).toContain("telemetrySource: 'sidebar'")
    expect(handlerSection).toContain("recordFeatureInteraction('linear-tasks')")
    expect(handlerSection).toContain('openComposerForLinearItem(issue)')
  })

  it('resumes an attachment from the primary action and composes when none exists', () => {
    const section = sourceBetween(
      TASK_PAGE_SOURCE,
      'const handleOpenOrUseGitHubWorkItem = useCallback(',
      'const openComposerForGitLabItem = useCallback('
    )

    expect(section).toContain('findGithubWorkItemWorkspaceAttachment(')
    expect(section).toContain('if (!currentAttached)')
    expect(section).toContain('handleUseWorkItem(item)')
    expect(section).toContain('activateAndRevealWorktree(currentAttached.id)')
  })

  it('uses the shared composer handler from GitHub detail and start-new actions', () => {
    expect(TASK_PAGE_SOURCE.match(/onUse=\{\(item\) => \{/g)).toHaveLength(2)
    expect(TASK_PAGE_SOURCE.match(/onSelect=\{\(\) => handleUseWorkItem\(item\)\}/g)).toHaveLength(
      2
    )
  })

  it('keeps project-view GitHub actions on the direct start-work path for issue #4756', () => {
    const section = sourceBetween(
      PROJECT_VIEW_SOURCE,
      '// Why: issue #4756 keeps project-view actions on the direct',
      'openModalFallback: () => {'
    )

    expect(PROJECT_VIEW_SOURCE).toContain('issue #4756')
    expect(section).toContain('void launchWorkItemDirect({')
    expect(section).toContain("launchSource: 'task_page'")
    expect(section).not.toContain('createGitHubWorkItemWorkspaceInBackground')
  })
})
