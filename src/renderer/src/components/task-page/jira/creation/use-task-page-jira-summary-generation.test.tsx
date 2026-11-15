// @vitest-environment happy-dom
import { act, useState } from 'react'
import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssueSummaryGenerationResult } from '../../../../../../shared/jira/jira-issue-summary-generation'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import { useTaskPageJiraSummaryGeneration } from './use-task-page-jira-summary-generation'

const mocks = vi.hoisted(() => ({ generate: vi.fn(), cancel: vi.fn(), error: vi.fn() }))
vi.mock('@/runtime/jira/runtime-jira-summary-generation-client', () => ({
  generateRuntimeJiraIssueSummary: mocks.generate,
  cancelRuntimeJiraIssueSummary: mocks.cancel
}))
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
  sourceHost: 'local',
  accountHost: 'local',
  hasSourceContext: true,
  accountLabel: 'Account one',
  providerSite: 'site-1',
  project: 'ORCA',
  type: 'Bug'
}
function setup() {
  return renderHook(
    (props) => {
      const [title, setTitle] = useState('')
      return useTaskPageJiraSummaryGeneration({
        accountBackedTaskSourceHostId:
          props.accountHost === 'local'
            ? LOCAL_EXECUTION_HOST_ID
            : toRuntimeExecutionHostId(props.accountHost),
        jiraTaskSourceContext: props.hasSourceContext
          ? {
              kind: 'task-source',
              provider: 'jira',
              projectId: 'source-project',
              hostId:
                props.sourceHost === 'local'
                  ? LOCAL_EXECUTION_HOST_ID
                  : toRuntimeExecutionHostId(props.sourceHost),
              accountLabel: props.accountLabel,
              providerIdentity: { provider: 'jira', siteId: props.providerSite }
            }
          : null,
        newJiraIssueOpen: props.open,
        newJiraIssueBody: props.body,
        newJiraIssueTitle: title,
        newJiraIssueSubmitting: false,
        newJiraIssueTargetProject: {
          id: props.project,
          key: props.project,
          name: props.project,
          siteId: 'site-1'
        },
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
  it('cancels on the captured account owner and ignores its reply after changing owners', async () => {
    const pending = deferred()
    mocks.generate.mockReturnValue(pending.promise)
    const { result, rerender } = setup()
    rerender({ ...initialProps, hasSourceContext: false, accountHost: 'account-a' })
    let request!: Promise<void>
    act(() => {
      request = result.current.handleGenerateNewJiraIssueSummary()
    })
    rerender({ ...initialProps, hasSourceContext: false, accountHost: 'account-b' })
    await act(async () => {
      pending.resolve({ success: true, summary: 'Wrong owner title' })
      await request
    })
    expect(result.current.newJiraIssueTitle).toBe('')
    expect(mocks.cancel).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'account-a' },
      expect.objectContaining({ siteId: 'site-1' })
    )
  })

  it('ignores output from an earlier visit to the same Jira owner', async () => {
    const old = deferred()
    const newer = deferred()
    mocks.generate.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
    const { result, rerender } = setup()
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.handleGenerateNewJiraIssueSummary()
    })
    rerender({ ...initialProps, sourceHost: 'remote-2' })
    rerender(initialProps)
    act(() => {
      second = result.current.handleGenerateNewJiraIssueSummary()
    })
    await act(async () => {
      old.resolve({ success: true, summary: 'Earlier owner visit' })
      await first
    })
    expect(result.current.newJiraIssueTitle).toBe('')
    expect(result.current.newJiraIssueSummaryGenerating).toBe(true)
    await act(async () => {
      newer.resolve({ success: true, summary: 'Current draft title' })
      await second
    })
    expect(result.current.newJiraIssueTitle).toBe('Current draft title')
  })

  it('preserves a title edited and restored before the result arrives', async () => {
    const pending = deferred()
    mocks.generate.mockReturnValue(pending.promise)
    const { result } = setup()
    let request!: Promise<void>
    act(() => {
      request = result.current.handleGenerateNewJiraIssueSummary()
    })
    act(() => {
      result.current.handleNewJiraIssueTitleChange('Manual')
      result.current.handleNewJiraIssueTitleChange('')
    })
    await act(async () => {
      pending.resolve({ success: true, summary: 'AI title' })
      await request
    })
    expect(result.current.newJiraIssueTitle).toBe('')
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
