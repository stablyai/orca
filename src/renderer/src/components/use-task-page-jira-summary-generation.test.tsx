// @vitest-environment happy-dom
import { act, useState } from 'react'
import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssueSummaryGenerationResult } from '../../../shared/jira-issue-summary-generation'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { useTaskPageJiraSummaryGeneration } from './use-task-page-jira-summary-generation'

const mocks = vi.hoisted(() => ({ generate: vi.fn(), cancel: vi.fn(), error: vi.fn() }))
vi.mock('@/runtime/runtime-jira-summary-generation-client', () => ({
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

  it.each([
    { ...initialProps, body: 'A different description' },
    { ...initialProps, sourceHost: 'remote-2' },
    { ...initialProps, accountLabel: 'Account two' },
    { ...initialProps, providerSite: 'site-2' }
  ])('keeps update guidance inline and clears it for another draft: %j', async (changed) => {
    mocks.generate.mockResolvedValue({ success: false, error: 'Update the Jira host.' })
    const { result, rerender } = setup()
    await act(async () => result.current.handleGenerateNewJiraIssueSummary())
    expect(result.current.newJiraIssueSummaryError).toBe('Update the Jira host.')
    rerender(changed)
    expect(result.current.newJiraIssueSummaryError).toBeNull()
  })

  it('uses the Jira source host and account', async () => {
    mocks.generate.mockResolvedValue({ success: true, summary: 'Remote title' })
    const { result, rerender } = setup()
    rerender({ ...initialProps, context: 'remote-1', sourceHost: 'remote-1' })
    await act(async () => result.current.handleGenerateNewJiraIssueSummary())
    expect(mocks.generate).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'remote-1' },
      expect.objectContaining({ siteId: 'site-1', description: initialProps.body }),
      expect.any(AbortSignal)
    )
    expect(result.current.newJiraIssueTitle).toBe('Remote title')
  })

  it('uses the captured account host when no source context is available', async () => {
    mocks.generate.mockResolvedValue({ success: true, summary: 'Owned title' })
    const { result, rerender } = setup()
    rerender({ ...initialProps, hasSourceContext: false, accountHost: 'account-owner' })
    await act(async () => result.current.handleGenerateNewJiraIssueSummary())
    expect(mocks.generate).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'account-owner' },
      expect.objectContaining({ siteId: 'site-1' }),
      expect.any(AbortSignal)
    )
    expect(result.current.newJiraIssueTitle).toBe('Owned title')
  })

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

  it.each([
    { ...initialProps, sourceHost: 'remote-2' },
    { ...initialProps, accountLabel: 'Account two' },
    { ...initialProps, providerSite: 'site-2' }
  ])(
    'discards output when the Jira source changes with a stable global host key: %j',
    async (changed) => {
      const pending = deferred()
      mocks.generate.mockReturnValue(pending.promise)
      const { result, rerender } = setup()
      let request!: Promise<void>
      act(() => {
        request = result.current.handleGenerateNewJiraIssueSummary()
      })
      rerender(changed)
      await act(async () => {
        pending.resolve({ success: true, summary: 'Wrong source title' })
        await request
      })
      expect(result.current.newJiraIssueTitle).toBe('')
      expect(mocks.cancel).toHaveBeenCalledWith(
        { kind: 'local' },
        expect.objectContaining({ siteId: 'site-1' })
      )
    }
  )

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

  it('preserves a title typed while generation is running', async () => {
    const pending = deferred()
    mocks.generate.mockReturnValue(pending.promise)
    const { result } = setup()
    let request!: Promise<void>
    act(() => {
      request = result.current.handleGenerateNewJiraIssueSummary()
    })
    act(() => result.current.handleNewJiraIssueTitleChange('My title'))
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
