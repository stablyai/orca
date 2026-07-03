import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TASK_PAGE_SOURCE = readFileSync(join(__dirname, 'TaskPage.tsx'), 'utf8')
const PROJECT_VIEW_SOURCE = readFileSync(
  join(__dirname, 'github-project', 'ProjectViewWrapper.tsx'),
  'utf8'
)

function sourceBetween(source: string, startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('GitHub workspace creation source boundaries', () => {
  it('routes the TaskPage GitHub create path through background creation first', () => {
    const section = sourceBetween(
      TASK_PAGE_SOURCE,
      'const handleUseWorkItem = useCallback(',
      'const handleOpenOrUseGitHubWorkItem = useCallback('
    )

    expect(section).toContain('createGitHubWorkItemWorkspaceInBackground({')
    expect(section).toContain('openModalFallback: () => openComposerForItem(item)')
    expect(section).not.toContain("openModal('new-workspace-composer'")
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
