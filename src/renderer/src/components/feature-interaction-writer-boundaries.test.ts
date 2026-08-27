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
    const source = componentSource('WorktreeJumpPalette.tsx')
    const renderStart = source.lastIndexOf('  return (')
    expect(renderStart).toBeGreaterThan(0)

    const handlerSection = source.slice(0, renderStart)
    const renderSection = source.slice(renderStart)

    const cmdJWriterPattern = /recordFeatureInteraction\('cmd-j/g
    const allCmdJWriterCount = source.match(cmdJWriterPattern)?.length ?? 0
    expect(allCmdJWriterCount).toBeGreaterThanOrEqual(6)
    expect(handlerSection.match(cmdJWriterPattern)?.length ?? 0).toBe(allCmdJWriterCount)
    expect(renderSection).not.toContain("recordFeatureInteraction('cmd-j")
    expect(
      sourceBetween(source, 'const handleQueryChange', 'const cancelFallbackFocusFrames')
    ).not.toContain("recordFeatureInteraction('cmd-j")
  })

  it('keeps task-provider writers off filters, tab switches, query edits, refresh, and pagination', () => {
    const providerWriter = /recordFeatureInteraction\('(github|gitlab|linear)-tasks'\)/
    const taskPage = componentSource('TaskPage.tsx')
    const pageLoader = componentSource('task-page/hooks/use-task-page-github-page-loader.ts')

    const passiveSections = [
      sourceBetween(taskPage, 'const handleRefreshGithubTasks', 'const {\n    newIssueOpen'),
      sourceBetween(pageLoader, 'const handleLoadNextPage', 'return { handleLoadNextPage }'),
      sourceBetween(taskPage, 'const handleApplyTaskSearch', 'const handleSetDefaultTaskPreset'),
      sourceBetween(
        taskPage,
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
        componentSource('task-page/hooks/use-task-page-use-item-actions.ts'),
        'const handleOpenOrUseGitHubWorkItem',
        'const openComposerForGitLabItem'
      )
    ).toContain(githubWriter)
  })

  it('threads GitHub task source context through inline task mutations', () => {
    const sections = [
      componentSource('task-page/github/github-status-cell.tsx'),
      componentSource('task-page/github/github-assignees-cell.tsx'),
      componentSource('task-page/github/pr-review-cell.tsx'),
      componentSource('task-page/github/pr-merge-cell.tsx'),
      sourceBetween(
        componentSource('task-page/hooks/use-task-page-create-github-submit.ts'),
        'const handleCreateNewIssue',
        'return { handleCreateNewIssue }'
      )
    ]

    for (const section of sections) {
      expect(section).toContain('sourceContext')
    }
    const rowSource = componentSource('task-page/github/github-work-item-row.tsx')
    expect(rowSource).toContain(
      "const rowSourceContext = getTaskPageRepoSourceContext(itemRepo, 'github')"
    )
    expect(rowSource).toContain('sourceContext={rowSourceContext}')
  })

  it('suppresses Tasks surface telemetry for in-page provider switches and detail opens', () => {
    const suppression = 'recordTasksInteraction: false'
    const githubDetailSection = sourceBetween(
      componentSource('TaskPage.tsx'),
      'const openGitHubDetailPage',
      'const patchTaskPageWorkItemRows'
    )

    const inPageNavigationSections = [
      sourceBetween(
        componentSource('task-page/hooks/use-task-page-selected-issue-state.ts'),
        'const openLinearDetailPage',
        'const openRelatedLinearIssue'
      ),
      sourceBetween(
        componentSource('task-page/chrome/task-page-source-toolbar.tsx'),
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
    const source = componentSource('WorktreeJumpPalette.tsx')
    const section = sourceBetween(source, 'const handleSelectQuickAction', 'const handleSelectItem')

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
    const dialogSource = componentSource('GitLabItemDialog.tsx')
    const gitlabWriter = "recordFeatureInteraction('gitlab-tasks')"

    expect(
      sourceBetween(
        componentSource('task-page/gitlab/gitlab-work-item-list.tsx'),
        '{displayedGitLabItems.map((item) => (',
        'handleUseGitLabItem(item)'
      ).match(/recordFeatureInteraction\('gitlab-tasks'\)/g)
    ).toHaveLength(2)
    expect(
      sourceBetween(
        componentSource('task-page/hooks/use-task-page-use-item-actions.ts'),
        'const handleUseGitLabItem',
        'return {'
      )
    ).toContain(gitlabWriter)

    const mutationSections = [
      sourceBetween(dialogSource, 'const handleSaveDetails', 'const handleRetryJob'),
      sourceBetween(dialogSource, 'const handleSetReviewers', 'const handleSubmitInlineComment'),
      sourceBetween(dialogSource, 'const handleSubmitInlineComment', 'const handleClose'),
      sourceBetween(dialogSource, 'const handleClose', 'const handleReopen'),
      sourceBetween(dialogSource, 'const handleReopen', 'const handleMerge'),
      sourceBetween(dialogSource, 'const handleMerge', 'const handleSubmitComment'),
      sourceBetween(dialogSource, 'const handleSubmitComment', 'const handleResolveDiscussion'),
      sourceBetween(dialogSource, 'const handleResolveDiscussion', 'const Icon =')
    ]
    for (const section of mutationSections) {
      expect(section).toContain(gitlabWriter)
      expect(section).toContain('showGitLabMutationError')
    }
  })

  it('keeps nested GitLab row actions from also opening task details by keyboard', () => {
    const rowSection = sourceBetween(
      componentSource('task-page/gitlab/gitlab-work-item-list.tsx'),
      'onKeyDown={(event) => {',
      'className="grid w-full cursor-pointer'
    )
    expect(rowSection).toContain('event.target !== event.currentTarget')
    expect(rowSection.indexOf('event.target !== event.currentTarget')).toBeLessThan(
      rowSection.indexOf("event.key === 'Enter'")
    )
  })

  it('keys GitLab rows by repository and item identity across hosts', () => {
    expect(componentSource('task-page/gitlab/gitlab-work-item-list.tsx')).toContain(
      'key={`${item.repoId}:${item.id}`}'
    )
  })

  it('records Linear provider-depth for inline edits, board drops, creation, and workspace use', () => {
    const drawerSource = componentSource('LinearItemDrawer.tsx')
    const linearWriter = "recordFeatureInteraction('linear-tasks')"

    const taskPageSections = [
      sourceBetween(
        componentSource('task-page/linear/linear-state-cell.tsx'),
        'export function LinearStateCell',
        'return ('
      ),
      sourceBetween(
        componentSource('task-page/hooks/use-task-page-linear-board.tsx'),
        'const handleLinearBoardDrop',
        'const toggleLinearDisplayProperty'
      ),
      sourceBetween(
        componentSource('task-page/hooks/use-task-page-create-linear-submits.tsx'),
        'const handleCreateNewLinearIssue',
        'return {'
      ),
      sourceBetween(
        componentSource('task-page/hooks/use-task-page-linear-actions.ts'),
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
      sourceBetween(drawerSource, 'const handleLabelToggle', 'return ('),
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
        componentSource('task-page/hooks/use-task-page-jira-actions.ts'),
        'const handleUseJiraItem',
        'return {'
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
