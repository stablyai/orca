// @vitest-environment happy-dom

import type { ComponentProps, JSX } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  AiVaultSession,
  AiVaultSubagentListResult
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
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
  vi.restoreAllMocks()
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

    // Hold the replacement read pending to verify retained rows do not flicker away.
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
