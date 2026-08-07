// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { VaultSessionRow } from './AiVaultSessionRow'

const session = {
  id: 'local:gemini:sess-1:/home/a/.gemini/s.json',
  executionHostId: 'local',
  agent: 'gemini',
  sessionId: 'sess-1',
  title: 'A session',
  cwd: null,
  branch: null,
  model: null,
  filePath: '/home/a/.gemini/s.json',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: 0,
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'gemini --resume sess-1',
  subagent: null
} as unknown as AiVaultSession

function renderRow(handlers: { onToggleDetails: () => void; onRequestDelete?: () => void }) {
  return render(
    <TooltipProvider>
      <VaultSessionRow
        session={session}
        liveState={null}
        resumeStartup={{ command: 'gemini --resume sess-1' }}
        realHomeResumeStartup={{ command: 'gemini --resume sess-1' }}
        worktreeInfo={null}
        vaultScope="all"
        detailsExpanded={false}
        resumeDisabled={false}
        onToggleDetails={handlers.onToggleDetails}
        showJumpToWorktree={false}
        onResume={vi.fn()}
        resumeLabel="Resume in New Tab"
        resumeActions={{} as never}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
        onRequestDelete={handlers.onRequestDelete ?? vi.fn()}
      />
    </TooltipProvider>
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('VaultSessionRow details toggle', () => {
  it('does not expand the row when a menu action is chosen', async () => {
    // Radix portals the menu out of the row's DOM, but React bubbles its
    // clicks back through the component tree. Expanding here would leave the
    // row open behind the confirm dialog, and still open after cancelling.
    const onToggleDetails = vi.fn()
    const onRequestDelete = vi.fn()
    renderRow({ onToggleDetails, onRequestDelete })
    const user = userEvent.setup()

    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    expect(onRequestDelete).toHaveBeenCalledTimes(1)
    expect(onToggleDetails).not.toHaveBeenCalled()
  })

  it('still expands when the row itself is clicked', async () => {
    const onToggleDetails = vi.fn()
    const { container } = renderRow({ onToggleDetails })
    const user = userEvent.setup()

    // The session title: inside the row body, so its click reaches the row's
    // own handler — the path a user takes to expand a row. Queried first-match
    // because Radix's asChild trigger repeats the subtree.
    const title = container.querySelector('[title="Drag to resume in a new tab"]')
    expect(title).not.toBeNull()
    await user.click(title as Element)

    expect(onToggleDetails).toHaveBeenCalledTimes(1)
  })
})
