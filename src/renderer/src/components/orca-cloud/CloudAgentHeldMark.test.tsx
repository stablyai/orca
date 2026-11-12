// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import {
  holdCloudAgentLaunch,
  releaseCloudAgentHold
} from '@/lib/orca-cloud/cloud-agent-launch-hold'
import {
  setOrcaCloudAgentAccountsStateForTest,
  type OrcaCloudAgentAccountsState
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { CloudAgentHeldMark } from './CloudAgentHeldMark'

function accountsNotSetUp(
  claude: 'none' | 'active' | 'revoked' = 'none'
): OrcaCloudAgentAccountsState {
  return {
    load: {
      kind: 'ready',
      status: {
        credentials: {
          claude: { state: claude },
          codex: { state: 'none' },
          providerEnabled: { claude: true, codex: true }
        },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  }
}

function renderMark(worktreeId: string) {
  return render(
    <TooltipProvider>
      <CloudAgentHeldMark worktreeId={worktreeId} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  setOrcaCloudAgentAccountsStateForTest(accountsNotSetUp())
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mark reads only tab ids
    tabsByWorktree: { wt1: [{ id: 'web-terminal-1' }], wt2: [{ id: 'web-terminal-2' }] } as never
  })
})

afterEach(() => {
  act(() => releaseCloudAgentHold('tab:web-terminal-1', 'cancel'))
  cleanup()
})

describe('sidebar mark for a held cloud agent (N-03)', () => {
  it('marks the workspace whose pane holds Claude, with the tooltip text as its label', async () => {
    await act(async () => {
      void holdCloudAgentLaunch({
        decided: true,
        paneKey: 'tab:web-terminal-1',
        agent: 'claude',
        prompt: null
      })
    })
    const { getByRole } = renderMark('wt1')
    expect(getByRole('img').getAttribute('aria-label')).toBe('Claude isn’t set up for Orca Cloud')
  })

  it('marks only that workspace, and clears once the hold is released (Start)', async () => {
    await act(async () => {
      void holdCloudAgentLaunch({
        decided: true,
        paneKey: 'tab:web-terminal-1',
        agent: 'claude',
        prompt: null
      })
    })
    expect(renderMark('wt2').queryByRole('img')).toBeNull()
    cleanup()
    const { queryByRole } = renderMark('wt1')
    expect(queryByRole('img')).not.toBeNull()
    act(() => releaseCloudAgentHold('tab:web-terminal-1', 'proceed'))
    expect(queryByRole('img')).toBeNull()
  })

  it('HELD-STALE-COVERED: the mark follows the hold: key while not set up, muted once set up, key on a revoke', async () => {
    await act(async () => {
      void holdCloudAgentLaunch({
        decided: true,
        paneKey: 'tab:web-terminal-1',
        agent: 'claude',
        prompt: null
      })
    })
    const { getByRole } = renderMark('wt1')
    expect(getByRole('img').getAttribute('data-cloud-agent-held')).toBe('notSetUp')
    await act(async () => setOrcaCloudAgentAccountsStateForTest(accountsNotSetUp('active')))
    expect(getByRole('img').getAttribute('data-cloud-agent-held')).toBe('awaitingStart')
    expect(getByRole('img').getAttribute('class')).toContain('text-muted-foreground')
    await act(async () => setOrcaCloudAgentAccountsStateForTest(accountsNotSetUp('revoked')))
    expect(getByRole('img').getAttribute('data-cloud-agent-held')).toBe('accountExpired')
    expect(getByRole('img').getAttribute('aria-label')).toBe('Claude sign-in expired')
  })
})
