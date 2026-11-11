// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { GITHUB_TASK_SEARCH_IDLE_MS } from '@/components/use-github-task-search-commit'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import {
  Harness,
  installSourceDisplayTestLifecycle,
  repo,
  view
} from './use-task-page-source-display.test-fixture'

vi.mock('@/components/github/PRFilterDropdowns', () => ({ default: () => null }))

installSourceDisplayTestLifecycle()

afterEach(() => {
  vi.useRealTimers()
})

function chip(name: string) {
  return screen.getByRole('button', { name })
}

describe('GitHub PR state × who chips', () => {
  it('saves Open × Mine as the Mine preset after the persist effect and idle commit', () => {
    vi.useFakeTimers()
    useAppStore.setState({
      repos: [repo],
      settings: createGlobalSettingsFixture({ defaultRepoSelection: [repo.id] }),
      taskPageData: { taskSource: 'github' }
    })
    render(<Harness />)
    act(() => {
      view.setTaskSearchInput('is:pr is:merged')
      view.setAppliedTaskSearch('is:pr is:merged')
      view.setTaskResumeApplied(true)
    })
    expect(chip('Merged')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(chip('Open'))
    fireEvent.click(chip('Mine'))
    act(() => {
      vi.advanceTimersByTime(GITHUB_TASK_SEARCH_IDLE_MS + 1)
    })

    expect(useAppStore.getState().taskResumeState).toMatchObject({
      githubItemsPreset: 'my-prs',
      githubItemsQuery: 'author:@me is:pr is:open'
    })
    expect(view.taskSearchInput).toBe('author:@me is:pr is:open')
    expect(chip('Open')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('Mine')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(chip('Merged'))
    expect(useAppStore.getState().taskResumeState).toMatchObject({
      githubItemsPreset: null,
      githubItemsQuery: 'is:pr is:merged author:@me'
    })
  })
})
