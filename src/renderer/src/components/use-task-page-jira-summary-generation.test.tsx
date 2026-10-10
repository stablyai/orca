// @vitest-environment happy-dom
import { act, useState } from 'react'
import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssueSummaryGenerationResult } from '../../../shared/jira-issue-summary-generation'
import { useTaskPageJiraSummaryGeneration } from './use-task-page-jira-summary-generation'

const mocks = vi.hoisted(() => ({ generate: vi.fn(), cancel: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function deferred() {
  let resolve!: (value: JiraIssueSummaryGenerationResult) => void
  const promise = new Promise<JiraIssueSummaryGenerationResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const initialProps = {
  open: true,
  body: 'Original description',
  context: 'local',
  project: 'ORCA',
  type: 'Bug'
}
function setup() {
  return renderHook(
    (props) => {
      const [title, setTitle] = useState('')
      return useTaskPageJiraSummaryGeneration({
        newJiraIssueOpen: props.open,
        newJiraIssueBody: props.body,
        newJiraIssueTitle: title,
        newJiraIssueSubmitting: false,
        newJiraIssueTargetProject: { id: props.project, key: props.project, name: props.project },
        newJiraIssueTargetType: { id: props.type, name: props.type },
        providerRuntimeContextKey: props.context,
        setNewJiraIssueTitle: setTitle
      })
    },
    { initialProps }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cancel.mockResolvedValue(undefined)
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      jira: { generateIssueSummary: mocks.generate, cancelGenerateIssueSummary: mocks.cancel }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Jira title generation lifecycle', () => {
  it('keeps the form usable without desktop generation in the web client', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    const { result } = setup()
    expect(result.current.newJiraIssueSummaryAvailable).toBe(false)
    await act(async () => result.current.handleGenerateNewJiraIssueSummary())
    act(() => result.current.setNewJiraIssueTitle('Manually written title'))
    expect(result.current.newJiraIssueTitle).toBe('Manually written title')
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('preserves a title typed while generation is running', async () => {
    const pending = deferred()
    mocks.generate.mockReturnValue(pending.promise)
    const { result } = setup()
    let request!: Promise<void>
    act(() => {
      request = result.current.handleGenerateNewJiraIssueSummary()
    })
    act(() => result.current.setNewJiraIssueTitle('My title'))
    await act(async () => {
      pending.resolve({ success: true, summary: 'AI title' })
      await request
    })
    expect(result.current.newJiraIssueTitle).toBe('My title')
  })

  it.each([
    { ...initialProps, body: 'A different issue' },
    { ...initialProps, context: 'ssh:other' },
    { ...initialProps, project: 'OTHER' },
    { ...initialProps, type: 'Task' },
    { ...initialProps, open: false }
  ])('discards generation after the draft changes: %j', async (changed) => {
    const pending = deferred()
    mocks.generate.mockReturnValue(pending.promise)
    const { result, rerender } = setup()
    let request!: Promise<void>
    act(() => {
      request = result.current.handleGenerateNewJiraIssueSummary()
    })
    await act(async () => rerender(changed))
    expect(mocks.cancel).toHaveBeenCalledOnce()
    expect(result.current.newJiraIssueSummaryGenerating).toBe(false)
    await act(async () => {
      pending.resolve({ success: true, summary: 'Stale title' })
      await request
    })
    expect(result.current.newJiraIssueTitle).toBe('')
  })

  it('allows a new request after close/reopen before the old request finishes', async () => {
    const old = deferred()
    const newer = deferred()
    mocks.generate.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
    const { result, rerender } = setup()
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.handleGenerateNewJiraIssueSummary()
    })
    await act(async () => rerender({ ...initialProps, open: false }))
    rerender(initialProps)
    act(() => {
      second = result.current.handleGenerateNewJiraIssueSummary()
    })
    await act(async () => {
      old.resolve({ success: true, summary: 'Old' })
      await first
    })
    expect(result.current.newJiraIssueSummaryGenerating).toBe(true)
    await act(async () => {
      newer.resolve({ success: true, summary: 'New' })
      await second
    })
    expect(result.current.newJiraIssueTitle).toBe('New')
  })

  it('invalidates the result even when cancel IPC rejects', async () => {
    const pending = deferred()
    mocks.generate.mockReturnValue(pending.promise)
    mocks.cancel.mockRejectedValue(new Error('Disconnected'))
    const { result } = setup()
    let request!: Promise<void>
    act(() => {
      request = result.current.handleGenerateNewJiraIssueSummary()
    })
    await act(async () => result.current.handleCancelNewJiraIssueSummaryGeneration())
    await act(async () => {
      pending.resolve({ success: true, summary: 'Ignored' })
      await request
    })
    expect(result.current.newJiraIssueTitle).toBe('')
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
