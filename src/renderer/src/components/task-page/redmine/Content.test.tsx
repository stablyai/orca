import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TaskPageRedmineContent } from './Content'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'

const { mockState } = vi.hoisted(() => ({ mockState: {} as Record<string, unknown> }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(mockState)
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const emptyStatus = () => ({
  connected: false,
  activeSite: null,
  selectedSiteId: null,
  viewer: null,
  error: null
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mockState, {
    redmineStatus: emptyStatus(),
    checkRedmineConnection: vi.fn().mockResolvedValue(undefined),
    listRedmineIssues: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
    getRedmineIssue: vi.fn().mockResolvedValue(null),
    connectRedmine: vi.fn().mockResolvedValue({ ok: true })
  })
})

function renderStatic(taskSource: string) {
  return renderToStaticMarkup(
    React.createElement(TaskPageRedmineContent, {
      model: {
        taskSource: taskSource as 'redmine',
        hideTaskSource: vi.fn()
      } as unknown as TaskPageComposerActionsModel
    })
  )
}

describe('TaskPageRedmineContent', () => {
  it('renders a null shell when a different provider is active', () => {
    expect(renderStatic('jira')).toBe('')
  })

  it('renders the connect prompt with site + api key fields when not connected', () => {
    const html = renderStatic('redmine')
    expect(html).toContain('Connect your Redmine server')
    expect(html).toContain('Server URL')
    expect(html).toContain('API key')
  })

  it('does not render the connect prompt once connected', () => {
    mockState.redmineStatus = { ...emptyStatus(), connected: true }
    const html = renderStatic('redmine')
    expect(html).not.toContain('Connect your Redmine server')
  })
})
