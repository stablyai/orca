import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname

function componentSource(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8')
}

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('feature interaction writer boundaries', () => {
  it('keeps Cmd+J feature writers in open/selection handlers, not query or navigation rendering', () => {
    // Selection and create callbacks now live in focused hooks; the surface only renders them.
    const selectionSource = componentSource('use-worktree-jump-palette-selection-actions.ts')
    const lifecycleSource = componentSource('use-worktree-jump-palette-selection-lifecycle.ts')
    const createSource = componentSource('use-worktree-jump-palette-create-action.ts')
    const handlerSection = [selectionSource, lifecycleSource, createSource].join('\n')
    const renderSection = componentSource('worktree-jump-palette-surface.tsx')

    const cmdJWriterPattern = /recordFeatureInteraction\('cmd-j/g
    const allCmdJWriterCount = handlerSection.match(cmdJWriterPattern)?.length ?? 0
    expect(allCmdJWriterCount).toBeGreaterThanOrEqual(6)
    expect(handlerSection.match(cmdJWriterPattern)?.length ?? 0).toBe(allCmdJWriterCount)
    expect(renderSection).not.toContain("recordFeatureInteraction('cmd-j")
    expect(
      sourceBetween(lifecycleSource, 'const handleQueryChange', 'const cancelFallbackFocusFrames')
    ).not.toContain("recordFeatureInteraction('cmd-j")
  })

  it('keeps task-provider writers off filters, tab switches, query edits, refresh, and pagination', () => {
    const providerWriter = /recordFeatureInteraction\('(github|gitlab|linear)-tasks'\)/
    const refreshSource = componentSource('use-task-page-github-cache-reconciliation.ts')
    const paginationSource = componentSource('use-task-page-github-search-pagination.ts')
    const searchSource = componentSource('use-task-page-search-actions.ts')

    const passiveSections = [
      sourceBetween(refreshSource, 'const handleRefreshGithubTasks', 'const nextModel'),
      sourceBetween(paginationSource, 'const handleLoadNextPage', 'const commitTaskSearch'),
      sourceBetween(searchSource, 'const applyPRFilterChange', 'const handleApplyTaskSearch'),
      sourceBetween(searchSource, 'const handleApplyTaskSearch', 'const handleTaskSearchChange'),
      sourceBetween(
        searchSource,
        'const handleTaskSearchChange',
        'const handleSetDefaultTaskPreset'
      ),
      sourceBetween(
        searchSource,
        'const handleSelectGithubTaskKind',
        'const handleResetGithubTaskSearch'
      )
    ]
    for (const section of passiveSections) {
      expect(section).not.toMatch(providerWriter)
    }
  })

  it('records GitHub provider-depth for inline item mutation success paths', () => {
    const githubWriter = "recordFeatureInteraction('github-tasks')"
    // Why: table cells route success telemetry through the optimistic mutation
    // hook so provider-depth recording stays on one confirm path.
    const hookSource = readFileSync(
      join(COMPONENT_ROOT, '../hooks/useTaskPageGitHubWorkItemMutation.ts'),
      'utf8'
    )
    expect(
      sourceBetween(hookSource, "if (confirmed === 'confirmed')", 'return confirmed')
    ).toContain(githubWriter)
    expect(
      sourceBetween(
        componentSource('use-task-page-workspace-actions.ts'),
        'const handleOpenOrUseGitHubWorkItem',
        'const openComposerForGitLabItem'
      )
    ).toContain(githubWriter)
  })

  it('threads GitHub task source context through inline task mutations', () => {
    const sections = [
      componentSource('task-page/github/StatusCell.tsx'),
      componentSource('task-page/github/AssigneesCell.tsx'),
      componentSource('task-page/github/ReviewCell.tsx'),
      componentSource('task-page/github/MergeCell.tsx'),
      sourceBetween(
        componentSource('use-task-page-github-issue-creation.ts'),
        'const handleCreateNewIssue',
        'const nextModel'
      )
    ]

    for (const section of sections) {
      expect(section).toContain('sourceContext')
    }
    const rowSource = componentSource('task-page/github/Rows.tsx')
    // Rows inline the repo lookup per cell rather than hoisting one const.
    expect(
      rowSource.match(/sourceContext=\{getTaskPageRepoSourceContext\(itemRepo, 'github'\)\}/g)
    ).toHaveLength(4)
  })

  it('suppresses Tasks surface telemetry for in-page provider switches and detail opens', () => {
    const suppression = 'recordTasksInteraction: false'
    const githubDetailSection = sourceBetween(
      componentSource('use-task-page-github-detail.ts'),
      'const openGitHubDetailPage',
      'const nextModel'
    )

    const inPageNavigationSections = [
      sourceBetween(
        componentSource('use-task-page-detail-routing.ts'),
        'const openLinearDetailPage',
        'const openRelatedLinearIssue'
      ),
      sourceBetween(
        componentSource('task-page/SourceBar.tsx'),
        'taskSourceManuallyChangedRef.current = true',
        'void updateSettings'
      )
    ]

    expect(githubDetailSection).toContain('openGitHubSourceContext')
    expect(githubDetailSection).toContain('openTaskPage')
    expect(githubDetailSection).toContain(suppression)

    for (const section of inPageNavigationSections) {
      expect(section).toContain(suppression)
    }
  })

  it('records Cmd+J create-workspace as its own destination, not a generic quick action', () => {
    const source = componentSource('use-worktree-jump-palette-selection-actions.ts')
    const section = sourceBetween(
      source,
      'const handleSelectQuickAction',
      'const handleSelectProjectTarget'
    )

    expect(section).toContain("recordFeatureInteraction('cmd-j-create-workspace')")
    expect(section).toContain("recordFeatureInteraction('cmd-j-quick-action')")
    expect(section.indexOf("recordFeatureInteraction('cmd-j-create-workspace')")).toBeLessThan(
      section.indexOf("recordFeatureInteraction('cmd-j-quick-action')")
    )
    expect(
      sourceBetween(
        section,
        "if (action.id === 'create-workspace')",
        "recordFeatureInteraction('cmd-j-quick-action')"
      )
    ).toContain('return')
  })

  it('records GitLab provider-depth for detail opens, workspace use, and dialog mutations', () => {
    const detailsSource = componentSource('gitlab-item-dialog/use-gitlab-details-editing.ts')
    const primarySource = componentSource('gitlab-item-dialog/use-gitlab-primary-actions.ts')
    const reviewSource = componentSource('gitlab-item-dialog/use-gitlab-review-actions.ts')
    const gitlabWriter = "recordFeatureInteraction('gitlab-tasks')"

    expect(
      sourceBetween(
        componentSource('task-page/gitlab/ItemList.tsx'),
        '{displayedGitLabItems.map((item) => (',
        'handleUseGitLabItem(item)'
      ).match(/recordFeatureInteraction\('gitlab-tasks'\)/g)
    ).toHaveLength(2)
    expect(
      sourceBetween(
        componentSource('use-task-page-workspace-actions.ts'),
        'const handleUseGitLabItem',
        'const nextModel'
      )
    ).toContain(gitlabWriter)

    const mutationSections = [
      sourceBetween(detailsSource, 'const handleSaveDetails', 'return {'),
      sourceBetween(reviewSource, 'const handleSetReviewers', 'const handleSubmitInlineComment'),
      sourceBetween(
        reviewSource,
        'const handleSubmitInlineComment',
        'const handleResolveDiscussion'
      ),
      sourceBetween(primarySource, 'const handleClose', 'const handleReopen'),
      sourceBetween(primarySource, 'const handleReopen', 'const handleMerge'),
      sourceBetween(primarySource, 'const handleMerge', 'const handleSubmitComment'),
      sourceBetween(primarySource, 'const handleSubmitComment', 'return {'),
      sourceBetween(reviewSource, 'const handleResolveDiscussion', 'return {')
    ]
    for (const section of mutationSections) {
      expect(section).toContain(gitlabWriter)
      expect(section).toContain('showGitLabMutationError')
    }
  })

  it('keeps nested GitLab row actions from also opening task details by keyboard', () => {
    const rowSection = sourceBetween(
      componentSource('task-page/gitlab/ItemList.tsx'),
      'onKeyDown={(e) => {',
      'className="grid w-full cursor-pointer'
    )
    expect(rowSection).toContain('e.target !== e.currentTarget')
    expect(rowSection.indexOf('e.target !== e.currentTarget')).toBeLessThan(
      rowSection.indexOf("e.key === 'Enter'")
    )
  })

  it('keys GitLab rows by repository and item identity across hosts', () => {
    expect(componentSource('task-page/gitlab/ItemList.tsx')).toContain(
      'key={`${item.repoId}:${item.id}`}'
    )
  })

  it('records Linear provider-depth for inline edits, board drops, creation, and workspace use', () => {
    const drawerSource = [
      componentSource('linear-item-drawer-edit-controller.tsx'),
      componentSource('linear-item-drawer-comment-footer.tsx')
    ].join('\n')
    const linearWriter = "recordFeatureInteraction('linear-tasks')"

    const taskPageSections = [
      sourceBetween(
        componentSource('task-page-linear-issue-model.tsx'),
        'export function LinearStateCell',
        'return ('
      ),
      sourceBetween(
        componentSource('use-task-page-linear-board.ts'),
        'const handleLinearBoardDrop',
        'const toggleLinearDisplayProperty'
      ),
      sourceBetween(
        componentSource('use-task-page-linear-issue-creation.ts'),
        'const handleCreateNewLinearIssue',
        'const nextModel'
      ),
      sourceBetween(
        componentSource('use-task-page-composer-actions.ts'),
        'const handleUseLinearItem',
        'const handleLinearWorkspaceChange'
      )
    ]
    for (const section of taskPageSections) {
      expect(section).toContain(linearWriter)
    }

    const drawerMutationSections = [
      sourceBetween(drawerSource, 'const handleStateChange', 'const handlePriorityChange'),
      sourceBetween(drawerSource, 'const handlePriorityChange', 'const handleEstimateChange'),
      sourceBetween(drawerSource, 'const handleEstimateChange', 'const handleEstimateSubmit'),
      sourceBetween(drawerSource, 'const handleAssigneeChange', 'const handleLabelToggle'),
      sourceBetween(drawerSource, 'const handleLabelToggle', 'return {'),
      sourceBetween(drawerSource, 'const handleSubmit = useCallback(async () => {', 'return (')
    ]
    for (const section of drawerMutationSections) {
      expect(section).toContain(linearWriter)
    }
  })

  it('records Jira provider-depth for workspace use', () => {
    const jiraWriter = "recordFeatureInteraction('jira-tasks')"

    // End boundary is the declaration after the handler: the Jira connect flow
    // now lives in the shared JiraConnectDialog, so handleJiraConnect (the prior
    // marker) no longer exists in TaskPage.
    expect(
      sourceBetween(
        componentSource('use-task-page-composer-actions.ts'),
        'const handleUseJiraItem',
        'const nextModel'
      )
    ).toContain(jiraWriter)
  })

  it('records browser annotation agent handoff only from the prompt-delivered callback', () => {
    const source = componentSource('browser-pane/annotate/use-browser-page-annotation-send.ts')
    expect(
      source.match(/recordFeatureInteraction\('browser-annotations-sent-to-agent'\)/g)
    ).toHaveLength(1)
    expect(
      sourceBetween(
        source,
        'const handleBrowserAnnotationsSentToAgent',
        'const handleClearBrowserAnnotations'
      )
    ).toContain("recordFeatureInteraction('browser-annotations-sent-to-agent')")
    expect(
      sourceBetween(
        source,
        'const handleCopyBrowserAnnotations',
        'const handleBrowserAnnotationsSentToAgent'
      )
    ).not.toContain("recordFeatureInteraction('browser-annotations-sent-to-agent')")
    expect(
      sourceBetween(
        source,
        'const handleClearBrowserAnnotations',
        'const handleDeleteBrowserAnnotation'
      )
    ).not.toContain("recordFeatureInteraction('browser-annotations-sent-to-agent')")
  })

  it('records floating workspace hide only from explicit disable or hide actions', () => {
    const allowedSources = [
      componentSource('settings/FloatingWorkspacePane.tsx'),
      componentSource('floating-terminal/FloatingTerminalIconContextMenu.tsx')
    ].join('\n')
    const passiveSources = [
      componentSource('../App.tsx'),
      componentSource('floating-terminal/FloatingTerminalPanel.tsx')
    ].join('\n')

    expect(
      allowedSources.match(/recordFeatureInteraction\('floating-workspace-hidden'\)/g) ?? []
    ).toHaveLength(2)
    expect(passiveSources).not.toContain("recordFeatureInteraction('floating-workspace-hidden')")
  })
})
