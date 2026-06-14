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

function componentBodyBeforeRender(source: string, componentName: string): string {
  return sourceBetween(source, `function ${componentName}`, '\n  return (\n    <')
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
    const source = componentSource('TaskPage.tsx')
    const providerWriter = /recordFeatureInteraction\('(github|gitlab|linear)-tasks'\)/

    const passiveSections = [
      sourceBetween(source, 'const handleRefreshGithubTasks', 'const [newIssueOpen'),
      sourceBetween(
        source,
        'const handleLoadNextPage',
        'useEffect(() => {\n    if (!taskResumeApplied)'
      ),
      sourceBetween(source, 'const handleApplyTaskSearch', 'const handleSetDefaultTaskPreset'),
      sourceBetween(source, 'const handleSelectGithubTaskKind', 'const handleResetGithubTaskSearch')
    ]
    for (const section of passiveSections) {
      expect(section).not.toMatch(providerWriter)
    }
  })

  it('records GitHub provider-depth for inline item mutation success paths', () => {
    const source = componentSource('TaskPage.tsx')
    const githubWriter = "recordFeatureInteraction('github-tasks')"
    const mutationSections = [
      sourceBetween(source, 'function GHAssigneesCell', 'const triggerContent ='),
      sourceBetween(source, 'function PRReviewCell', 'const requestReviewer ='),
      componentBodyBeforeRender(source, 'PRMergeCell'),
      sourceBetween(
        source,
        'const handleOpenOrUseGitHubWorkItem',
        'const openComposerForGitLabItem'
      )
    ]

    for (const section of mutationSections) {
      expect(section).toContain(githubWriter)
    }
  })

  it('threads GitHub task source context through inline task mutations', () => {
    const source = componentSource('TaskPage.tsx')
    const sections = [
      sourceBetween(source, 'function GHStatusCell', 'function GitHubAssigneeAvatar'),
      sourceBetween(source, 'function GHAssigneesCell', 'const triggerContent ='),
      sourceBetween(source, 'function PRReviewCell', 'function PRChecksCell'),
      componentBodyBeforeRender(source, 'PRMergeCell'),
      sourceBetween(source, 'const handleCreateNewIssue', 'const handleCreateNewLinearProject')
    ]

    for (const section of sections) {
      expect(section).toContain('sourceContext')
    }
    const rowRenderStart = source.indexOf('filteredWorkItems.map((item) => {')
    expect(rowRenderStart).toBeGreaterThanOrEqual(0)
    expect(source.slice(rowRenderStart, rowRenderStart + 12_000)).toContain(
      'sourceContext={getTaskPageRepoSourceContext(itemRepo,'
    )
  })

  it('suppresses Tasks surface telemetry for in-page provider switches and detail opens', () => {
    const source = componentSource('TaskPage.tsx')
    const suppression = 'recordTasksInteraction: false'
    const githubDetailSection = sourceBetween(
      source,
      'const openGitHubDetailPage',
      'const patchTaskPageWorkItemRows'
    )

    const inPageNavigationSections = [
      sourceBetween(source, 'const openLinearDetailPage', 'const openRelatedLinearIssue'),
      sourceBetween(source, 'taskSourceManuallyChangedRef.current = true', 'void updateSettings')
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
    const taskPageSource = componentSource('TaskPage.tsx')
    const dialogSource = componentSource('GitLabItemDialog.tsx')
    const gitlabWriter = "recordFeatureInteraction('gitlab-tasks')"

    expect(
      sourceBetween(
        taskPageSource,
        '{displayedGitLabItems.map((item) => (',
        '<GitLabItemDialog'
      ).match(/recordFeatureInteraction\('gitlab-tasks'\)/g)
    ).toHaveLength(2)
    expect(
      sourceBetween(taskPageSource, 'const handleUseGitLabItem', 'const handleCreateNewIssue')
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
    }
  })

  it('records Linear provider-depth for inline edits, board drops, creation, and workspace use', () => {
    const taskPageSource = componentSource('TaskPage.tsx')
    const drawerSource = componentSource('LinearItemDrawer.tsx')
    const linearWriter = "recordFeatureInteraction('linear-tasks')"

    const taskPageSections = [
      sourceBetween(taskPageSource, 'function LinearStateCell', 'return ('),
      sourceBetween(
        taskPageSource,
        'const handleLinearBoardDrop',
        'const toggleLinearDisplayProperty'
      ),
      sourceBetween(
        taskPageSource,
        'const handleCreateNewLinearIssue',
        'const openComposerForLinearItem'
      ),
      sourceBetween(
        taskPageSource,
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
    const taskPageSource = componentSource('TaskPage.tsx')
    const jiraWriter = "recordFeatureInteraction('jira-tasks')"

    expect(
      sourceBetween(taskPageSource, 'const handleUseJiraItem', 'const handleJiraConnect')
    ).toContain(jiraWriter)
  })

  it('records browser annotation agent handoff only from the prompt-delivered callback', () => {
    const source = componentSource('browser-pane/BrowserPane.tsx')
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
