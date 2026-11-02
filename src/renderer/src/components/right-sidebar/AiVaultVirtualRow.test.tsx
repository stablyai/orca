// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import type { AgentDotState } from '@/components/AgentStateDot'
import { useAppStore } from '@/store'
import { createEditorStore } from '@/store/slices/editor-slice-test-harness'
import { openAiVaultSessionLogInOrca } from './ai-vault-session-log-open'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'
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
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

function renderSession(
  session: AiVaultSession,
  blocked = false,
  searchHit?: AiVaultSearchHit,
  searchHitHostLabels?: ReadonlyMap<string, string>,
  logDetails?: { onOpenLog: (session: AiVaultSession) => Promise<void> },
  liveState: AgentDotState | null = null
) {
  if (logDetails) {
    Object.defineProperty(window, 'api', { configurable: true, value: { aiVault: {} } })
  }
  const buildResumeStartup = vi.fn(() => ({ command: session.resumeCommand }))
  const onCopyResume = vi.fn()
  const onResume = vi.fn()
  const onResumeInNewCli = vi.fn()
  render(
    <TooltipProvider>
      <AiVaultVirtualRow
        row={{ type: 'session', groupKey: 'today', session }}
        index={0}
        start={0}
        activeStickyHeaderIndex={null}
        measureElement={vi.fn()}
        collapsedGroups={new Set()}
        expandedSessionIds={new Set(logDetails ? [session.id] : [])}
        vaultScope="all"
        searchHits={searchHit ? new Map([[session.id, searchHit]]) : undefined}
        searchHitHostLabels={searchHitHostLabels}
        buildResumeStartup={buildResumeStartup}
        getOriginalPaneTarget={() => null}
        isStructuredSessionOpen={() => false}
        getSessionLiveState={() => liveState}
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
        onJumpToOriginalPane={vi.fn()}
        onJumpToWorktree={vi.fn()}
        onResume={onResume}
        onContinueInNewSession={vi.fn()}
        onResumeInNewChat={vi.fn()}
        onResumeInNewCli={onResumeInNewCli}
        onCopyResume={onCopyResume}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenLog={logDetails?.onOpenLog ?? vi.fn()}
        onRevealLog={vi.fn()}
        onOpenCwd={vi.fn()}
        onRequestDelete={vi.fn()}
      />
    </TooltipProvider>
  )
  return { buildResumeStartup, onCopyResume, onResume, onResumeInNewCli }
}

describe('AiVaultVirtualRow conversation logs', () => {
  it('opens a search-derived companion from the expanded View Log button', async () => {
    const store = createEditorStore()
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const hit: AiVaultSearchHit = {
      agent: 'grok',
      sessionId: 'grok-1',
      title: 'Grok result',
      cwd: '/repo',
      branch: null,
      updatedAt: null,
      messageCount: 1,
      score: 1,
      source: { presence: 'present', filePath: '/tmp/grok-1/summary.json' },
      evidence: null
    }
    renderSession(aiVaultSearchHitToSession(hit, 'local'), false, hit, undefined, {
      onOpenLog: openAiVaultSessionLogInOrca
    })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'View Log' }))

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/tmp/grok-1/chat_history.jsonl',
        relativePath: '/tmp/grok-1/chat_history.jsonl',
        readOnly: true,
        liveTail: true,
        runtimeEnvironmentId: null
      })
    ])
    await user.click(screen.getByTestId('ai-vault-session-more-actions'))
    await user.click(await screen.findByRole('menuitem', { name: 'Open Log' }))
    fireEvent.contextMenu(screen.getByText('Grok result'))
    await user.click(await screen.findByRole('menuitem', { name: 'Open Log' }))
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0].fileContentReloadNonce).toBe(2)
  })

  it.each(['overflow', 'context'] as const)(
    'omits Open Log for a database-backed row in the %s menu',
    async (menu) => {
      renderSession(
        {
          ...cliSession,
          agent: 'opencode2',
          filePath: '/tmp/opencode.db',
          messageCount: 0,
          previewMessages: [],
          queuedMessageCount: 1
        },
        false,
        undefined,
        undefined,
        { onOpenLog: openAiVaultSessionLogInOrca }
      )
      expect(screen.getByText('Conversation not saved')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'View Log' })).toBeNull()
      expect(screen.queryByText(/Open the log to recover them/)).toBeNull()
      const user = userEvent.setup()
      if (menu === 'overflow') {
        await user.click(screen.getByTestId('ai-vault-session-more-actions'))
      } else {
        fireEvent.contextMenu(screen.getByText('CLI session'))
      }
      expect(await screen.findByRole('menuitem', { name: 'Copy Session ID' })).toBeTruthy()
      expect(screen.queryByRole('menuitem', { name: 'Open Log' })).toBeNull()
    }
  )
})

it('passes semantic status through the virtual row to the real glyph', () => {
  renderSession(cliSession, false, undefined, undefined, undefined, 'monitoring')
  expect(screen.getByLabelText('Monitoring background tasks')).toBeTruthy()
})

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
