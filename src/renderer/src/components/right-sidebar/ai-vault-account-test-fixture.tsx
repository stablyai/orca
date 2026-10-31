import { memo } from 'react'
import { act, cleanup, fireEvent, render, within, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import { useAppStore } from '../../store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SessionInlineDetails } from './AiVaultSessionDetails'
import { SessionAccountSection } from './AiVaultSessionAccount'
import { useAiVaultSessionAccount } from './ai-vault-session-account'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'

export async function flushAccountWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

export function installAccountFixture(): void {
  const original = useAppStore.getState()
  beforeEach(() => {
    vi.stubGlobal('api', {
      aiVault: { getFirstUserPrompt: vi.fn().mockResolvedValue({ prompt: null }) }
    })
  })
  afterEach(async () => {
    cleanup()
    await flushAccountWork()
    useAppStore.setState(original, true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
}

export const accountRenders = new Map<string, number>()
export const AccountCard = memo(function AccountCard({ session }: { session: AiVaultSession }) {
  const label = useAiVaultSessionAccount(session)
  accountRenders.set(session.id, (accountRenders.get(session.id) ?? 0) + 1)
  return (
    <div data-testid={session.id}>
      <SessionAccountSection accountLabel={label} />
    </div>
  )
})
export function accountCards(sessions: AiVaultSession[]) {
  return sessions.map((session) => <AccountCard key={session.id} session={session} />)
}

export function accountSettings(size = 1): GlobalSettings {
  return {
    ...getDefaultSettings('/session-account-render'),
    activeClaudeManagedAccountId: 'different-selection',
    activeCodexManagedAccountId: 'different-selection',
    claudeManagedAccounts: Array.from({ length: size }, (_, index) => ({
      id: `claude-${index}`,
      email: `claude-${index}@example.com`,
      managedAuthPath: `/accounts/claude-${index}`,
      authMethod: 'unknown' as const,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    codexManagedAccounts: Array.from({ length: size }, (_, index) => ({
      id: `codex-${index}`,
      email: `codex-${index}@example.com`,
      managedHomePath: `/accounts/codex-${index}`,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }))
  }
}

export function recordedSession(agent: 'claude' | 'codex', index = 0): AiVaultSession {
  return {
    ...aiVaultSearchHitToSession(searchHit(), 'local'),
    id: `${agent}-${index}`,
    agent,
    accountHome: {
      variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: `/accounts/${agent}-${index}`
    }
  }
}

export function details(sessions: AiVaultSession[]): RenderResult & {
  account(id: string): ReturnType<typeof within>
  unknown(id: string): void
} {
  const resume = vi.fn()
  const panel = render(
    <TooltipProvider>
      {sessions.map((session) => (
        <div key={session.id} data-testid={session.id}>
          <SessionInlineDetails
            id={`details-${session.id}`}
            session={session}
            vaultScope="all"
            worktreeInfo={{ status: 'active', label: 'feature', path: '/repo/feature' }}
            resumeActions={{
              worktree: { worktreeId: null, disabled: true },
              newTab: { worktreeId: 'repo', disabled: false }
            }}
            onResumeInWorktree={resume}
            onResumeInNewTab={resume}
          />
        </div>
      ))}
    </TooltipProvider>
  )
  const account = (id: string) => {
    const card = panel.getByTestId(id)
    const section = within(card).getByText('Account').closest('section')
    if (!section) {
      throw new Error('Missing Account section')
    }
    expect(section.previousElementSibling?.textContent).toContain('Worktree')
    return within(section)
  }
  const unknown = (id: string) => {
    expect(account(id).getByText('Unknown').className).toContain('text-muted-foreground')
    resume.mockClear()
    fireEvent.click(
      within(panel.getByTestId(id)).getByRole('button', { name: 'Resume in New Tab' })
    )
    expect(resume).toHaveBeenCalledTimes(1)
  }
  return { ...panel, account, unknown }
}
