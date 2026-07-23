import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('claimAutomaticAgentResume', () => {
  // Why: Task 2 (pty-connection.ts cold-restore spawn) relies on this exact
  // claim shape to block a duplicate worktree-activation resume while the
  // spawning pane's sleeping record is deliberately left in place. See
  // activeOrQueuedResumeClaimsProviderSession in resume-sleeping-agent-session.ts
  // for the reader that matches on worktreeId/launchAgent/providerSession.
  it('cold-restore claim blocks duplicate activation resume for the same session', () => {
    useAppStore.getState().claimAutomaticAgentResume('tab-1', {
      worktreeId: 'wt-1',
      launchAgent: 'claude',
      providerSession: { key: 'session_id', id: 'persisted-session' }
    })
    expect(
      useAppStore.getState().automaticAgentResumeClaimsByTabId['tab-1']?.providerSession?.id
    ).toBe('persisted-session')
  })
})
