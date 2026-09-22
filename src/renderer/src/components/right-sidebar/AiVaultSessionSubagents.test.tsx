// @vitest-environment happy-dom

import type { ComponentProps, JSX } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentExpansionProvider } from './ai-vault-subagent-expansion'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession, AiVaultSubagentListResult } from '../../../../shared/ai-vault-types'
import { SessionSubagentsSection as ProductionSessionSubagentsSection } from './AiVaultSessionSubagents'

const listSubagentSessions = vi.fn<(args: unknown) => Promise<AiVaultSubagentListResult>>()

function SessionSubagentsSection(
  props: ComponentProps<typeof ProductionSessionSubagentsSection>
): JSX.Element {
  return (
    <TooltipProvider>
      <ProductionSessionSubagentsSection {...props} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  listSubagentSessions.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    aiVault: { listSubagentSessions },
    shell: { openFilePath: vi.fn() }
  }
})

afterEach(() => {
  cleanup()
})

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:claude:parent-session:/tmp/parent-session.jsonl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'parent-session',
    title: 'Parent session',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/tmp/parent-session.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-05T10:00:00.000Z',
    messageCount: 3,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 1,
    resumeCommand: 'claude --resume parent-session',
    subagent: null,
    ...overrides
  }
}

function makeSubagent(title: string): AiVaultSession {
  return makeSession({
    id: `local:claude:parent-session:/tmp/parent-session/subagents/agent-${title}.jsonl`,
    title,
    filePath: `/tmp/parent-session/subagents/agent-${title}.jsonl`,
    subagent: { parentSessionId: 'parent-session', agentType: null, status: 'running' },
    subagentTranscriptCount: 0
  })
}

describe('SessionSubagentsSection', () => {
  it('keeps the loaded list visible while a rescan-triggered refetch is in flight', async () => {
    listSubagentSessions.mockResolvedValueOnce({
      sessions: [makeSubagent('First pass')],
      issues: []
    })
    const { rerender, queryByText } = render(<SessionSubagentsSection session={makeSession()} />)
    await act(async () => {})
    expect(queryByText('First pass')).not.toBeNull()

    // Second fetch stays pending: the previous rows must remain visible
    // instead of flickering back to the hidden loading state.
    let resolveSecond: (result: AiVaultSubagentListResult) => void = () => {}
    listSubagentSessions.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSecond = resolve))
    )
    rerender(
      <SessionSubagentsSection session={makeSession({ modifiedAt: '2026-07-05T10:05:00.000Z' })} />
    )
    await act(async () => {})
    expect(listSubagentSessions).toHaveBeenCalledTimes(2)
    expect(queryByText('First pass')).not.toBeNull()

    await act(async () => {
      resolveSecond({ sessions: [makeSubagent('Second pass')], issues: [] })
    })
    expect(queryByText('Second pass')).not.toBeNull()
    expect(queryByText('First pass')).toBeNull()
  })

  it('labels the subagent run state exactly once, on the dot itself', async () => {
    listSubagentSessions.mockResolvedValueOnce({
      sessions: [makeSubagent('Running task')],
      issues: []
    })
    const { container } = render(<SessionSubagentsSection session={makeSession()} />)
    await act(async () => {})

    const titles = [...container.querySelectorAll('[title]')].map((element) =>
      element.getAttribute('title')
    )

    expect(titles).toEqual(['Running task', 'View Log'])
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).not.toBeNull()
  })

  it('does not fetch for remote sessions even when the scan counted transcripts', async () => {
    const { container } = render(
      <SessionSubagentsSection
        session={makeSession({ executionHostId: 'ssh:dev-box', subagentTranscriptCount: 2 })}
      />
    )
    await act(async () => {})
    expect(listSubagentSessions).not.toHaveBeenCalled()
    expect(container.firstChild).toBeNull()
  })
})

describe('independent child resume', () => {
  const child = makeSession({
    agent: 'omp',
    sessionId: 'child-id',
    filePath: '/repo/session/tasks/worker.jsonl',
    subagent: { parentSessionId: 'parent-session', agentType: 'worker', status: 'completed' },
    subagentTranscriptCount: 0
  })
  it('passes the complete child and its resolved folder target to resume', async () => {
    listSubagentSessions.mockResolvedValue({ sessions: [child], issues: [] })
    const resume = {
      getState: vi.fn(() => ({
        blocked: false,
        worktreeId: 'folder:repo',
        usesSessionWorktree: true
      })),
      onResume: vi.fn()
    }
    const { getByRole } = render(
      <SessionSubagentsSection session={makeSession({ agent: 'omp' })} resume={resume} />
    )
    await act(async () => {})
    fireEvent.click(getByRole('button', { name: 'Resume in Worktree' }))
    expect(resume.getState).toHaveBeenCalledWith(child)
    expect(resume.onResume).toHaveBeenCalledExactlyOnceWith(child, 'folder:repo')
  })
  it.each([
    { agent: 'claude' as const },
    { sessionId: 'parent-session' },
    { sessionId: '' },
    { filePath: '' },
    { messageCount: 0, previewMessages: [] }
  ])('withholds resume for a non-independent or empty child %j', async (overrides) => {
    listSubagentSessions.mockResolvedValue({ sessions: [{ ...child, ...overrides }], issues: [] })
    const resume = { getState: vi.fn(), onResume: vi.fn() }
    const { queryByRole } = render(
      <SessionSubagentsSection session={makeSession()} resume={resume} />
    )
    await act(async () => {})
    expect(queryByRole('button', { name: /Resume/ })).toBeNull()
    expect(resume.getState).not.toHaveBeenCalled()
  })
  it('disables resume when the existing target resolver blocks the child host', async () => {
    listSubagentSessions.mockResolvedValue({ sessions: [child], issues: [] })
    const resume = {
      getState: vi.fn(() => ({ blocked: true, worktreeId: null, usesSessionWorktree: false })),
      onResume: vi.fn()
    }
    const { getByRole } = render(
      <SessionSubagentsSection session={makeSession()} resume={resume} />
    )
    await act(async () => {})
    const button = getByRole('button', { name: 'Resume in New Tab' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(resume.onResume).not.toHaveBeenCalled()
  })
})

describe('nested OMP history', () => {
  const parent = makeSession({ agent: 'omp' })
  const child = {
    ...makeSubagent('Worker'),
    agent: 'omp' as const,
    sessionId: 'worker',
    subagentTranscriptCount: 1
  }
  const grandchild = { ...makeSubagent('Research'), agent: 'omp' as const, sessionId: 'research' }

  it('loads only opened branches and targets the grandchild when resuming', async () => {
    listSubagentSessions
      .mockResolvedValueOnce({ sessions: [child, makeSubagent('Sibling')], issues: [] })
      .mockResolvedValueOnce({ sessions: [grandchild], issues: [] })
    const resume = {
      getState: vi.fn(() => ({
        blocked: false,
        worktreeId: 'folder:repo',
        usesSessionWorktree: true
      })),
      onResume: vi.fn()
    }
    const view = render(<SessionSubagentsSection session={parent} resume={resume} />)
    await act(async () => {})
    expect(listSubagentSessions).toHaveBeenCalledTimes(1)
    expect(view.queryByText('Research')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Subagents (1)' }))
    await act(async () => {})
    expect(listSubagentSessions).toHaveBeenLastCalledWith({
      agent: 'omp',
      executionHostId: 'local',
      parentFilePath: child.filePath
    })
    expect(view.queryByText('Research')).not.toBeNull()
    fireEvent.click(view.getAllByRole('button', { name: 'Resume in Worktree' })[1])
    expect(resume.onResume).toHaveBeenCalledExactlyOnceWith(grandchild, 'folder:repo')
  })

  it('does not show another parent’s rows while its listing is pending', async () => {
    listSubagentSessions
      .mockResolvedValueOnce({ sessions: [child], issues: [] })
      .mockImplementationOnce(() => new Promise(() => {}))
    const view = render(<SessionSubagentsSection session={parent} />)
    await act(async () => {})
    view.rerender(
      <SessionSubagentsSection session={{ ...parent, filePath: '/tmp/replacement.jsonl' }} />
    )
    expect(view.queryByText('Worker')).toBeNull()
  })

  it('ignores late nested results after collapse and refetches on reopen', async () => {
    let resolveChild: (value: AiVaultSubagentListResult) => void = () => {}
    listSubagentSessions
      .mockResolvedValueOnce({ sessions: [child], issues: [] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveChild = resolve
          })
      )
      .mockResolvedValueOnce({ sessions: [grandchild], issues: [] })
    const view = render(<SessionSubagentsSection session={parent} />)
    await act(async () => {})
    const disclosure = view.getByRole('button', { name: 'Subagents (1)' })
    fireEvent.click(disclosure)
    fireEvent.click(disclosure)
    await act(async () => {
      resolveChild({ sessions: [grandchild], issues: [] })
    })
    expect(view.queryByText('Research')).toBeNull()
    fireEvent.click(disclosure)
    await act(async () => {})
    expect(view.queryByText('Research')).not.toBeNull()
    expect(listSubagentSessions).toHaveBeenCalledTimes(3)
  })

  it('keeps cyclic and remote children from offering a disclosure', async () => {
    listSubagentSessions.mockResolvedValueOnce({
      sessions: [
        { ...child, filePath: parent.filePath },
        { ...child, id: 'remote', executionHostId: 'ssh:box' }
      ],
      issues: []
    })
    const view = render(<SessionSubagentsSection session={parent} />)
    await act(async () => {})
    expect(view.queryByRole('button', { name: 'Subagents (1)' })).toBeNull()
    expect(listSubagentSessions).toHaveBeenCalledTimes(1)
  })

  it('offers retry for a failed branch listing', async () => {
    listSubagentSessions
      .mockResolvedValueOnce({ sessions: [child], issues: [] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ sessions: [grandchild], issues: [] })
    const view = render(<SessionSubagentsSection session={parent} />)
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: 'Subagents (1)' }))
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(view.queryByText('Research')).not.toBeNull()
  })
  it('retains expanded branches across a virtual row unmount and same-parent rescan', async () => {
    listSubagentSessions.mockImplementation(async (args) => ({
      sessions:
        typeof args === 'object' &&
        args !== null &&
        'parentFilePath' in args &&
        args.parentFilePath === parent.filePath
          ? [child]
          : [grandchild],
      issues: []
    }))
    const fixture = (visible: boolean, modifiedAt = parent.modifiedAt) => (
      <SubagentExpansionProvider>
        {visible ? <SessionSubagentsSection session={{ ...parent, modifiedAt }} /> : null}
      </SubagentExpansionProvider>
    )
    const view = render(fixture(true))
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: 'Subagents (1)' }))
    await act(async () => {})
    view.rerender(fixture(true, '2026-09-14T12:00:00Z'))
    await act(async () => {})
    expect(view.queryByText('Research')).not.toBeNull()
    view.rerender(fixture(false))
    view.rerender(fixture(true))
    await act(async () => {})
    expect(view.queryByText('Research')).not.toBeNull()
  })

  it('preserves readable rows when the WSL gate reports partial listing issues and allows retry', async () => {
    listSubagentSessions
      .mockResolvedValueOnce({
        sessions: [child],
        issues: [{ agent: 'omp', path: parent.filePath, message: 'WSL unavailable' }]
      })
      .mockResolvedValueOnce({ sessions: [], issues: [] })
    const view = render(<SessionSubagentsSection session={parent} />)
    await act(async () => {})
    expect(view.queryByText('Worker')).not.toBeNull()
    expect(view.queryByText('Could not load all subagents.')).not.toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(view.queryByText('No subagents found.')).not.toBeNull()
    expect(view.queryByText('Worker')).toBeNull()
  })

  it('never accepts a late response from a replaced parent', async () => {
    let finish: (value: AiVaultSubagentListResult) => void = () => {}
    listSubagentSessions
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValueOnce({ sessions: [grandchild], issues: [] })
    const view = render(<SessionSubagentsSection session={parent} />)
    view.rerender(
      <SessionSubagentsSection session={{ ...parent, filePath: '/new-parent.jsonl' }} />
    )
    await act(async () => {
      finish({ sessions: [child], issues: [] })
    })
    expect(view.queryByText('Research')).not.toBeNull()
    expect(view.queryByText('Worker')).toBeNull()
  })
})
