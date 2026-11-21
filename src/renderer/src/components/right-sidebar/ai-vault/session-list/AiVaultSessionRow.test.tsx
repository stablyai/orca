// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultSessionWorktreeInfo } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-worktree'
import type { AiVaultSearchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-types'
import type { AiVaultSubagentResumeActions } from './AiVaultSessionSubagents'

import { VaultSessionRow } from './AiVaultSessionRow'

import type { AgentDotState } from '@/components/AgentStateDot'

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
  previewMessages: [{ role: 'assistant', text: 'Ready when you are' }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'gemini --resume sess-1',
  subagent: null
} as unknown as AiVaultSession

beforeEach(() => {
  // Expanded details read first-prompt/subagent APIs during render/mount.
  ;(window as unknown as { api: unknown }).api = {
    aiVault: {
      getFirstUserPrompt: vi.fn().mockResolvedValue({ prompt: null }),
      listSubagentSessions: vi.fn().mockResolvedValue({ sessions: [] })
    }
  }
})

afterEach(() => {
  // Without Vitest globals, Testing Library cannot auto-clean up; retained rows would duplicate queries.
  cleanup()
  vi.clearAllMocks()
  delete (window as unknown as { api?: unknown }).api
})

function renderRow(
  overrides: {
    liveState?: AgentDotState | null
    searchHit?: AiVaultSearchHit
    session?: AiVaultSession
    subagentResume?: AiVaultSubagentResumeActions
    detailsExpanded?: boolean
    worktreeInfo?: AiVaultSessionWorktreeInfo | null
    onToggleDetails?: () => void
    onJumpToOriginalPane?: () => void
    onCloseOriginalPane?: () => void
    onResume?: () => void
    resumeHidden?: boolean
    onRequestDelete?: () => void
    onPick?: () => void
  } = {}
) {
  return render(
    <TooltipProvider>
      <VaultSessionRow
        session={overrides.session ?? session}
        searchHit={overrides.searchHit}
        subagentResume={overrides.subagentResume}
        liveState={overrides.liveState ?? null}
        resumeStartup={{ command: 'gemini --resume sess-1' }}
        realHomeResumeStartup={{ command: 'gemini --resume sess-1' }}
        worktreeInfo={overrides.worktreeInfo ?? null}
        vaultScope="all"
        detailsExpanded={overrides.detailsExpanded ?? false}
        resumeDisabled={false}
        resumeHidden={overrides.resumeHidden}
        onToggleDetails={overrides.onToggleDetails ?? vi.fn()}
        onJumpToOriginalPane={overrides.onJumpToOriginalPane}
        onCloseOriginalPane={overrides.onCloseOriginalPane}
        showJumpToWorktree={false}
        onResume={overrides.onResume ?? vi.fn()}
        resumeLabel="Resume in New Tab"
        resumeActions={{
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: null, disabled: true }
        }}
        onResumeInWorktree={vi.fn()}
        onResumeInNewTab={vi.fn()}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
        onRequestDelete={overrides.onRequestDelete ?? vi.fn()}
        onPick={overrides.onPick}
      />
    </TooltipProvider>
  )
}

describe('VaultSessionRow details toggle', () => {
  it('does not expand the row when a menu action is chosen', async () => {
    // Portaled menu clicks still bubble through React; Delete must not expand the row behind its dialog.
    const onToggleDetails = vi.fn()
    const onRequestDelete = vi.fn()
    renderRow({ onToggleDetails, onRequestDelete })
    const user = userEvent.setup()

    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    expect(onRequestDelete).toHaveBeenCalledTimes(1)
    expect(onToggleDetails).not.toHaveBeenCalled()
  })
})

describe('VaultSessionRow in the /resume picker', () => {
  it('only resumes on click: no menus, drag or action buttons, and the chevron still shows details', async () => {
    const onPick = vi.fn()
    const onToggleDetails = vi.fn()
    const subagent = {
      ...session,
      id: 'sub',
      title: 'Sub task',
      filePath: '/home/a/.gemini/sub.json'
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        aiVault: {
          getFirstUserPrompt: vi.fn().mockResolvedValue({ prompt: null }),
          listSubagentSessions: vi.fn().mockResolvedValue({ sessions: [subagent], issues: [] })
        }
      }
    })
    const { container } = renderRow({
      session: { ...session, subagentTranscriptCount: 1 },
      onPick,
      onToggleDetails,
      detailsExpanded: true
    })
    const user = userEvent.setup()

    expect(await screen.findByText('Sub task')).toBeTruthy()
    expect(screen.queryByTitle('View Log')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Copy/ })).toBeNull()
    expect(screen.queryByTestId('ai-vault-session-more-actions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume in New Tab' })).toBeNull()
    expect(container.querySelector('[draggable="true"]')).toBeNull()
    const title = screen.getAllByText('A session')[0]
    fireEvent.contextMenu(title)
    expect(screen.queryByRole('menuitem')).toBeNull()

    await user.click(title)
    await user.click(screen.getByTestId('ai-vault-session-toggle-details'))
    expect(onPick).toHaveBeenCalledOnce()
    expect(onToggleDetails).toHaveBeenCalledOnce()
  })
})

describe('VaultSessionRow native session actions', () => {
  it('shows jump and close instead of Resume for an open session', async () => {
    const onJumpToOriginalPane = vi.fn()
    const onCloseOriginalPane = vi.fn()
    const onResume = vi.fn()
    renderRow({ resumeHidden: true, onJumpToOriginalPane, onCloseOriginalPane, onResume })

    expect(screen.queryByTestId('ai-vault-session-resume')).toBeNull()
    fireEvent.click(screen.getByTestId('ai-vault-session-jump-original-pane'))
    fireEvent.click(screen.getByTestId('ai-vault-session-close-original-pane'))

    expect(onJumpToOriginalPane).toHaveBeenCalledOnce()
    expect(onCloseOriginalPane).toHaveBeenCalledOnce()
    expect(onResume).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    expect(await screen.findByRole('menuitem', { name: 'Jump to Original Pane' })).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: 'Close Open Session' }))
    expect(screen.queryByRole('menuitem', { name: 'Resume in New Tab' })).toBeNull()
    expect(onCloseOriginalPane).toHaveBeenCalledTimes(2)

    fireEvent.contextMenu(screen.getAllByText('A session')[0])
    await user.click(await screen.findByRole('menuitem', { name: 'Close Open Session' }))
    expect(onCloseOriginalPane).toHaveBeenCalledTimes(3)
  })
})
