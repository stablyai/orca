import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TASK_PAGE_SOURCE = readFileSync(join(__dirname, 'TaskPage.tsx'), 'utf8')

describe('TaskPage GitHub primary action persistence', () => {
  it('remembers the last Start vs Open-in-browser choice as the next primary action', () => {
    expect(TASK_PAGE_SOURCE).toContain('resolveGitHubTaskSplitActions(githubTaskPrimaryAction)')
    expect(TASK_PAGE_SOURCE).toContain("setGitHubTaskPrimaryAction('open-in-browser')")
    expect(TASK_PAGE_SOURCE).toContain("setGitHubTaskPrimaryAction('start')")
    expect(TASK_PAGE_SOURCE).toContain("githubTaskSplitActions.primary === 'open-in-browser'")
    expect(TASK_PAGE_SOURCE).toContain("githubTaskSplitActions.menu.includes('start')")
    expect(TASK_PAGE_SOURCE).toContain('handleOpenOrUseGitHubWorkItem(item)')
    expect(TASK_PAGE_SOURCE).toContain('window.api.shell.openUrl(item.url)')
  })
})
