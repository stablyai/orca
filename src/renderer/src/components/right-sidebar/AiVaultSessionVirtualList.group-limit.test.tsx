// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import type { AiVaultListRow } from './AiVaultVirtualRow'
import type { AiVaultGroupSessionLimit } from './ai-vault-group-session-limit'
import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'

// Why: happy-dom has no layout, so render every row instead of a measured window.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 10 })),
    getTotalSize: () => count * 10,
    measureElement: () => {},
    scrollOffset: 0
  })
}))

vi.mock('./AiVaultVirtualRow', () => ({
  AiVaultVirtualRow: ({
    row,
    onToggleGroupExpanded
  }: {
    row: AiVaultListRow
    onToggleGroupExpanded: (groupKey: string) => void
  }) => {
    if (row.type === 'session') {
      return <div data-testid="session-row">{row.session.id}</div>
    }
    if (row.type === 'group-more') {
      return (
        <button type="button" onClick={() => onToggleGroupExpanded(row.groupKey)}>
          more:{row.groupKey}
        </button>
      )
    }
    return <div>{row.group.label}</div>
  }
}))

afterEach(() => {
  cleanup()
})

function session(id: string): AiVaultSession {
  return {
    id,
    executionHostId: 'local',
    agent: 'claude',
    sessionId: id,
    title: id,
    cwd: null,
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-15T02:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
}

const groups: AiVaultSessionListGroup[] = [
  {
    key: 'today',
    label: 'Today',
    sessions: Array.from({ length: 8 }, (_, index) => session(`s${index}`))
  }
]

function list(groupSessionLimit: AiVaultGroupSessionLimit): React.JSX.Element {
  const noop = vi.fn()
  return (
    <AiVaultSessionVirtualList
      groups={groups}
      collapsedGroups={new Set()}
      groupSessionLimit={groupSessionLimit}
      loading={false}
      sessionsCount={8}
      filteredSessionsCount={8}
      noAgentsSelected={false}
      error={null}
      vaultScope="all"
      buildResumeStartup={() => ({ command: '' })}
      getOriginalPaneTarget={() => null}
      isStructuredSessionOpen={() => false}
      getSessionLiveState={() => null}
      getWorktreeInfo={() => null}
      getSessionResumeState={() => ({
        blocked: true,
        worktreeId: null,
        usesSessionWorktree: false
      })}
      getSessionResumeActions={() => ({
        worktree: { worktreeId: null, disabled: true },
        newTab: { worktreeId: null, disabled: true }
      })}
      getSessionResumeInChat={() => ({ available: false, reason: 'already-structured' })}
      onToggleGroup={noop}
      onJumpToOriginalPane={noop}
      onJumpToWorktree={noop}
      onResume={noop}
      onContinueInNewSession={noop}
      onResumeInNewChat={noop}
      onResumeInNewCli={noop}
      onCopyResume={noop}
      onCopyId={noop}
      onCopyPath={noop}
      onOpenLog={noop}
      onRevealLog={noop}
      onOpenCwd={noop}
      onRequestDelete={noop}
    />
  )
}

describe('AiVaultSessionVirtualList group session limit', () => {
  it('collapses groups expanded under a previous limit when the limit changes', () => {
    const { rerender } = render(list(5))
    expect(screen.getAllByTestId('session-row')).toHaveLength(5)

    fireEvent.click(screen.getByRole('button', { name: 'more:today' }))
    expect(screen.getAllByTestId('session-row')).toHaveLength(8)

    rerender(list(3))
    expect(screen.getAllByTestId('session-row')).toHaveLength(3)
  })
})
