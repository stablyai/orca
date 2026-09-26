// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { AiVaultVirtualRow } from './AiVaultVirtualRow'

const cliSession: AiVaultSession = {
  id: 'local:codex:session-1:/tmp/session-1.jsonl',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'CLI session',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/tmp/session-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-09-17T00:00:00.000Z',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [{ role: 'user', text: 'Fix it', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume session-1',
  subagent: null
}

afterEach(() => {
  cleanup()
})

function renderSession(session: AiVaultSession) {
  const buildResumeStartup = vi.fn(() => ({ command: session.resumeCommand }))
  const onCopyResume = vi.fn()
  render(
    <TooltipProvider>
      <AiVaultVirtualRow
        row={{ type: 'session', groupKey: 'today', session }}
        index={0}
        start={0}
        activeStickyHeaderIndex={null}
        measureElement={vi.fn()}
        collapsedGroups={new Set()}
        expandedSessionIds={new Set()}
        vaultScope="all"
        buildResumeStartup={buildResumeStartup}
        getOriginalPaneTarget={() => null}
        isStructuredSessionOpen={() => false}
        getSessionLiveState={() => null}
        getWorktreeInfo={() => null}
        getSessionResumeState={() => ({
          blocked: false,
          worktreeId: 'worktree-1',
          usesSessionWorktree: false
        })}
        getSessionContinuationWorkspaceId={() => 'worktree-1'}
        getSessionResumeActions={() => ({
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: 'worktree-1', disabled: false }
        })}
        getSessionResumeInChat={() => ({ available: false, reason: 'already-structured' })}
        onToggleGroup={vi.fn()}
        onToggleSessionDetails={vi.fn()}
        onJumpToOriginalPane={vi.fn()}
        onJumpToWorktree={vi.fn()}
        onResume={vi.fn()}
        onContinueInNewSession={vi.fn()}
        onResumeInNewChat={vi.fn()}
        onCopyResume={onCopyResume}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenLog={vi.fn()}
        onRevealLog={vi.fn()}
        onOpenCwd={vi.fn()}
        onRequestDelete={vi.fn()}
      />
    </TooltipProvider>
  )
  return { buildResumeStartup, onCopyResume }
}

describe('AiVaultVirtualRow resume command actions', () => {
  it('keeps Copy Resume Command in overflow and context actions for CLI sessions', async () => {
    const { buildResumeStartup, onCopyResume } = renderSession(cliSession)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Resume Command' }))
    expect(onCopyResume).toHaveBeenCalledExactlyOnceWith(cliSession, 'worktree-1')

    fireEvent.contextMenu(screen.getByText('CLI session'))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Resume Command' }))
    expect(onCopyResume).toHaveBeenCalledTimes(2)
    expect(buildResumeStartup).toHaveBeenCalledTimes(2)
  })

  it('omits Copy Resume Command and legacy command preparation for native sessions', async () => {
    const nativeSession: AiVaultSession = {
      ...cliSession,
      id: 'local:codex:session-native:/tmp/session-native.jsonl',
      sessionId: 'session-native',
      title: 'Native session',
      structuredSession: { sessionId: 'session-native', workspaceId: 'worktree-1' }
    }
    const { buildResumeStartup, onCopyResume } = renderSession(nativeSession)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    expect(screen.queryByRole('menuitem', { name: 'Copy Resume Command' })).toBeNull()
    await user.keyboard('{Escape}')

    fireEvent.contextMenu(screen.getByText('Native session'))
    expect(screen.queryByRole('menuitem', { name: 'Copy Resume Command' })).toBeNull()
    expect(onCopyResume).not.toHaveBeenCalled()
    expect(buildResumeStartup).not.toHaveBeenCalled()
  })
})
