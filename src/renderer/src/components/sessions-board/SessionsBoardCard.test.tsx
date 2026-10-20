// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { SessionsBoardCardAvailability } from './sessions-board-card-availability'
import { sessionFolderName, SessionsBoardCard } from './SessionsBoardCard'

const session: AiVaultSession = {
  id: 'local:codex:sess-1:/home/a/.codex/sess-1.jsonl',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'sess-1',
  title: 'Ship the sessions board',
  cwd: 'F:\\project\\orca',
  branch: 'main',
  model: 'gpt-5-codex',
  filePath: '/home/a/.codex/sess-1.jsonl',
  codexHome: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  modifiedAt: '2026-01-02T00:00:00.000Z',
  messageCount: 7,
  totalTokens: 0,
  previewMessages: [{ role: 'assistant', text: 'Ready when you are', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume sess-1',
  subagent: null
}

/** A session in an open workspace: both actions offered. */
const availableCard: SessionsBoardCardAvailability = {
  worktreeInfo: { status: 'active', label: 'orca', path: 'F:\\project\\orca', worktreeId: 'wt-1' },
  jumpWorktreeId: 'wt-1',
  resumeWorktreeId: 'wt-1',
  resumeDisabled: false,
  resumeBlocked: false,
  canCopyResumeCommand: true
}

/** What the board hands a card whose cwd matches nothing it has open. */
const unavailableCard: SessionsBoardCardAvailability = {
  worktreeInfo: null,
  jumpWorktreeId: null,
  resumeWorktreeId: null,
  resumeDisabled: true,
  resumeBlocked: true,
  canCopyResumeCommand: true
}

function renderCard(overrides: {
  session?: AiVaultSession
  availability?: SessionsBoardCardAvailability | null
  onOpen?: () => void
  onCopy?: (text: string) => void
  onJump?: () => void
  onResume?: () => void
}): void {
  render(
    <TooltipProvider>
      <SessionsBoardCard
        session={overrides.session ?? session}
        availability={overrides.availability === undefined ? availableCard : overrides.availability}
        onOpen={overrides.onOpen ?? (() => undefined)}
        onCopy={overrides.onCopy ?? (() => undefined)}
        onJump={overrides.onJump ?? (() => undefined)}
        onResume={overrides.onResume ?? (() => undefined)}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('sessionFolderName', () => {
  it('takes the last segment of either separator and ignores a trailing one', () => {
    expect(sessionFolderName('F:\\project\\orca')).toBe('orca')
    expect(sessionFolderName('/home/a/orca/')).toBe('orca')
    expect(sessionFolderName('orca')).toBe('orca')
  })

  it('keeps a root path rather than returning nothing', () => {
    expect(sessionFolderName('/')).toBe('/')
  })
})

describe('SessionsBoardCard', () => {
  it('identifies the conversation without opening it', () => {
    renderCard({})

    expect(screen.getByText('Ship the sessions board')).toBeTruthy()
    expect(screen.getByText('Ready when you are')).toBeTruthy()
    expect(screen.getByText('7 msgs')).toBeTruthy()
    expect(screen.getByText('gpt-5-codex')).toBeTruthy()
    expect(screen.getByText('orca')).toBeTruthy()
  })

  it('opens the conversation when the card is clicked', async () => {
    const onOpen = vi.fn()
    renderCard({ onOpen })

    await userEvent.click(screen.getByTestId('sessions-board-card'))

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('copies the resume command from the overflow menu without opening the card', async () => {
    const onOpen = vi.fn()
    const onCopy = vi.fn()
    renderCard({ onOpen, onCopy })

    await userEvent.click(screen.getByLabelText('More session actions'))
    const item = await screen.findByText('Copy resume command')
    fireEvent.click(item)

    expect(onCopy).toHaveBeenCalledWith('codex resume sess-1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('falls back to the session id when the agent published no resume command', async () => {
    const onCopy = vi.fn()
    renderCard({ session: { ...session, resumeCommand: '' }, onCopy })

    await userEvent.click(screen.getByLabelText('More session actions'))

    expect(screen.queryByText('Copy resume command')).toBeNull()
    expect(await screen.findByText('Copy session ID')).toBeTruthy()
  })

  it('jumps and resumes without opening the conversation', async () => {
    const onJump = vi.fn()
    const onResume = vi.fn()
    const onOpen = vi.fn()
    renderCard({ onJump, onResume, onOpen })

    await userEvent.click(screen.getByTestId('sessions-board-card-jump'))
    await userEvent.click(screen.getByTestId('sessions-board-card-resume'))

    expect(onJump).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('carries the refusal reason in the accessible name, where a disabled button can read it', async () => {
    // A disabled button never opens its own tooltip, so the reason has to survive somewhere
    // a keyboard and a screen reader both reach.
    renderCard({ availability: unavailableCard })

    expect(screen.getByTestId('sessions-board-card-jump').getAttribute('aria-label')).toBe(
      'No worktree was recorded for this session.'
    )
    expect(screen.getByTestId('sessions-board-card-jump').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('sessions-board-card-resume').getAttribute('aria-label')).toBe(
      'No worktree was recorded for this session.'
    )
    expect(screen.getByTestId('sessions-board-card-resume').hasAttribute('disabled')).toBe(true)
  })

  it('names what the enabled actions do', () => {
    renderCard({})

    expect(screen.getByTestId('sessions-board-card-jump').getAttribute('aria-label')).toBe(
      'Jump to Worktree'
    )
    expect(screen.getByTestId('sessions-board-card-resume').getAttribute('aria-label')).toBe(
      'Resume in Worktree'
    )
  })

  it('blames the session, not the workspace, when there is nothing to resume', () => {
    renderCard({
      availability: { ...availableCard, resumeDisabled: true, resumeBlocked: false }
    })

    expect(screen.getByTestId('sessions-board-card-resume').getAttribute('aria-label')).toBe(
      'This session has no saved conversation to resume.'
    )
    expect(screen.getByTestId('sessions-board-card-jump').hasAttribute('disabled')).toBe(false)
  })

  it('does not offer to copy a resume command the session cannot resume', async () => {
    // Showing an enabled "Copy resume command" beside a disabled Resume is a contradiction.
    const onCopy = vi.fn()
    renderCard({
      availability: { ...availableCard, resumeDisabled: true, canCopyResumeCommand: false },
      onCopy
    })

    await userEvent.click(screen.getByLabelText('More session actions'))

    expect(screen.queryByText('Copy resume command')).toBeNull()
  })
})
