// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { SessionRowTrailingActions } from './SessionRowTrailingActions'

afterEach(cleanup)

const session: AiVaultSession = {
  id: 'local:claude:session-1:/tmp/session-1.jsonl',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'session-1',
  title: 'Session 1',
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
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'claude --resume session-1',
  subagent: null
}

function renderRow(): ReactElement {
  return (
    <SessionRowTrailingActions
      session={session}
      detailsExpanded={false}
      detailsId="session-details"
      detailsTooltip="Show Details"
      resumeDisabled={false}
      resumeLabel="Resume in New Tab"
      worktreeInfo={null}
      onToggleDetails={vi.fn()}
      showJumpToWorktree={false}
      onResume={vi.fn()}
      onCopyId={vi.fn()}
      onCopyPath={vi.fn()}
      deleteBlockedReason={null}
      onRequestDelete={vi.fn()}
    />
  )
}

describe('SessionRowTrailingActions overflow menus', () => {
  it('closes one row menu when another row opens its menu', async () => {
    render(
      <TooltipProvider>
        {renderRow()}
        {renderRow()}
      </TooltipProvider>
    )
    const [first, second] = screen.getAllByTestId('ai-vault-session-more-actions')

    fireEvent.pointerDown(first, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    await waitFor(() => expect(first.getAttribute('aria-expanded')).toBe('true'))

    fireEvent.pointerDown(second, { button: 0, ctrlKey: false, pointerType: 'mouse' })

    await waitFor(() => {
      expect(second.getAttribute('aria-expanded')).toBe('true')
      expect(first.getAttribute('aria-expanded')).toBe('false')
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    })
  })
})
