// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
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

function renderSession(
  session: AiVaultSession,
  blocked = false,
  searchHit?: AiVaultSearchHit,
  searchHitHostLabels?: ReadonlyMap<string, string>,
  openPane?: {
    onJumpToOriginalPane?: (session: AiVaultSession) => void
    onCloseOriginalPane?: (session: AiVaultSession) => void
    structuredSessionOpen?: boolean
  }
) {
  const buildResumeStartup = vi.fn(() => ({ command: session.resumeCommand }))
  const onCopyResume = vi.fn()
  const onResume = vi.fn()
  const onResumeInNewCli = vi.fn()
  const onJumpToOriginalPane = openPane?.onJumpToOriginalPane ?? vi.fn()
  const onCloseOriginalPane = openPane?.onCloseOriginalPane
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
        searchHits={searchHit ? new Map([[session.id, searchHit]]) : undefined}
        searchHitHostLabels={searchHitHostLabels}
        buildResumeStartup={buildResumeStartup}
        getOriginalPaneTarget={() =>
          openPane && !openPane.structuredSessionOpen
            ? {
                paneKey: 'pane-1',
                worktreeId: 'worktree-1',
                tabId: 'tab-1',
                leafId: 'leaf-1'
              }
            : null
        }
        isStructuredSessionOpen={() => openPane?.structuredSessionOpen ?? false}
        getSessionLiveState={() => null}
        getWorktreeInfo={() => null}
        getSessionResumeState={() => ({
          blocked,
          worktreeId: blocked ? null : 'worktree-1',
          usesSessionWorktree: false
        })}
        getSessionResumeActions={() => ({
          worktree: { worktreeId: null, disabled: true },
          newTab: { worktreeId: 'worktree-1', disabled: blocked }
        })}
        getSessionResumeInChat={() => ({ available: false, reason: 'already-structured' })}
        onToggleGroup={vi.fn()}
        onToggleSessionDetails={vi.fn()}
        onJumpToOriginalPane={onJumpToOriginalPane}
        onCloseOriginalPane={onCloseOriginalPane}
        onJumpToWorktree={vi.fn()}
        onResume={onResume}
        onContinueInNewSession={vi.fn()}
        onResumeInNewChat={vi.fn()}
        onResumeInNewCli={onResumeInNewCli}
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
  return {
    buildResumeStartup,
    onCopyResume,
    onResume,
    onResumeInNewCli,
    onJumpToOriginalPane,
    onCloseOriginalPane
  }
}

describe('AiVaultVirtualRow search hit source host', () => {
  it('names the host a hit came from when hits span several hosts', () => {
    renderSession(cliSession, false, undefined, new Map([['local', 'Local Mac']]))

    expect(screen.getByTitle('Found on Local Mac').textContent).toBe('Local Mac')
  })

  it('shows no host badge when every hit came from one host', () => {
    renderSession(cliSession)

    expect(screen.queryByTitle(/^Found on /)).toBeNull()
  })
})

describe('AiVaultVirtualRow resume command actions', () => {
  it('renders blocked IDE references without preparing an unsafe startup command', () => {
    const { buildResumeStartup } = renderSession(
      {
        ...cliSession,
        agent: 'antigravity',
        title: 'IDE reference on another host',
        filePath:
          '//wsl.localhost/Debian/home/example/.gemini/antigravity-ide/brain/id/transcript_full.jsonl'
      },
      true
    )
    expect(screen.getByText('IDE reference on another host')).toBeTruthy()
    expect(buildResumeStartup).not.toHaveBeenCalled()
  })

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

  it('opens a paired host native chat search hit that carries no resume command', async () => {
    const owner = { sessionId: 'session-native', workspaceId: 'worktree-1' }
    const session: AiVaultSession = {
      ...cliSession,
      id: 'runtime:paired:codex:session-1:',
      executionHostId: 'runtime:paired',
      title: 'Paired native chat',
      filePath: '',
      resumeCommand: '',
      structuredSession: owner
    }
    const hit: AiVaultSearchHit = {
      agent: 'codex',
      sessionId: 'session-1',
      title: 'Paired native chat',
      cwd: '/repo',
      branch: null,
      updatedAt: null,
      messageCount: 1,
      score: 1,
      source: { presence: 'present' },
      evidence: null,
      structuredSession: owner
    }
    const { onResume } = renderSession(session, false, hit)
    const user = userEvent.setup()

    fireEvent.contextMenu(screen.getByText('Paired native chat'))
    await user.click(await screen.findByRole('menuitem', { name: 'Resume in New Tab' }))
    expect(onResume).toHaveBeenCalledExactlyOnceWith(session, 'worktree-1')
  })
})

describe('AiVaultVirtualRow open session actions', () => {
  it('hides Play and offers jump and close when the original pane is open', () => {
    const onJumpToOriginalPane = vi.fn()
    const onCloseOriginalPane = vi.fn()
    renderSession(cliSession, false, undefined, undefined, {
      onJumpToOriginalPane,
      onCloseOriginalPane
    })

    expect(screen.queryByTestId('ai-vault-session-resume')).toBeNull()
    fireEvent.click(screen.getByTestId('ai-vault-session-jump-original-pane'))
    fireEvent.click(screen.getByTestId('ai-vault-session-close-original-pane'))
    expect(onJumpToOriginalPane).toHaveBeenCalledExactlyOnceWith(cliSession)
    expect(onCloseOriginalPane).toHaveBeenCalledExactlyOnceWith(cliSession)
  })

  it('hides Play and offers jump and close when the structured chat is open', () => {
    const onJumpToOriginalPane = vi.fn()
    const onCloseOriginalPane = vi.fn()
    const session: AiVaultSession = {
      ...cliSession,
      title: 'Open structured chat',
      structuredSession: { sessionId: 'session-1', workspaceId: 'worktree-1' }
    }
    renderSession(session, false, undefined, undefined, {
      onJumpToOriginalPane,
      onCloseOriginalPane,
      structuredSessionOpen: true
    })

    expect(screen.queryByTestId('ai-vault-session-resume')).toBeNull()
    fireEvent.click(screen.getByTestId('ai-vault-session-jump-original-pane'))
    fireEvent.click(screen.getByTestId('ai-vault-session-close-original-pane'))
    expect(onJumpToOriginalPane).toHaveBeenCalledExactlyOnceWith(session)
    expect(onCloseOriginalPane).toHaveBeenCalledExactlyOnceWith(session)
  })
})

describe('AiVaultVirtualRow Resume in New Terminal', () => {
  const owner = { sessionId: 'chat-1', workspaceId: 'worktree-1' }

  it.each(['claude', 'codex'] as const)(
    'offers the fork on a chat-owned %s row from both menus',
    async (agent) => {
      const session: AiVaultSession = { ...cliSession, agent, structuredSession: owner }
      const { onResumeInNewCli, onResume } = renderSession(session)
      const user = userEvent.setup()

      await user.click(screen.getByTestId('ai-vault-session-more-actions'))
      await user.click(await screen.findByRole('menuitem', { name: 'Resume in New Terminal' }))
      expect(onResumeInNewCli).toHaveBeenCalledExactlyOnceWith(session, 'worktree-1')

      fireEvent.contextMenu(screen.getByText('CLI session'))
      await user.click(await screen.findByRole('menuitem', { name: 'Resume in New Terminal' }))
      expect(onResumeInNewCli).toHaveBeenCalledTimes(2)
      expect(onResume).not.toHaveBeenCalled()
    }
  )

  it.each([
    { name: 'a terminal row', session: cliSession },
    {
      name: 'a chat-owned row of an agent that cannot fork',
      session: { ...cliSession, agent: 'gemini' as const, structuredSession: owner }
    }
  ])('does not offer the fork on $name', async ({ session }) => {
    renderSession(session)
    const user = userEvent.setup()

    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Resume in New Terminal' })).toBeNull()
  })
})
