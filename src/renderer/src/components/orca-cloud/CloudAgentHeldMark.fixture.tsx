import { Cloud } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { holdCloudAgentLaunch } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { setOrcaCloudAgentAccountsStateForTest } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { CloudAgentHeldMark } from './CloudAgentHeldMark'

type Scenario = 'notSetUp' | 'restored' | 'setUp' | 'expired'

function accounts(claude: 'none' | 'active' | 'revoked') {
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
  } as const
}

// A cloud workspace row whose Claude waits on its pane's strip (N-03). HELD-STALE-COVERED: the mark
// follows the hold's reason as the account changes under it (set up here, then revoked).
function seed(scenario: Scenario): void {
  const restored = scenario === 'restored'
  setOrcaCloudAgentAccountsStateForTest(accounts(restored ? 'active' : 'none'))
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mark reads only tab ids
    tabsByWorktree: { gudgeon: [{ id: 'web-terminal-g' }] } as never
  })
  void holdCloudAgentLaunch({
    decided: true,
    restored,
    paneKey: 'tab:web-terminal-g',
    agent: 'claude',
    prompt: null
  })
  if (scenario === 'setUp' || scenario === 'expired') {
    setOrcaCloudAgentAccountsStateForTest(accounts('active'))
  }
  if (scenario === 'expired') {
    setOrcaCloudAgentAccountsStateForTest(accounts('revoked'))
  }
}

function Row(): React.JSX.Element {
  return (
    <div className="flex w-[300px] items-center gap-1.5 rounded-md bg-accent/40 px-2 py-1.5 text-[13px]">
      <Cloud className="size-3 text-muted-foreground" aria-hidden />
      <span>gudgeon</span>
      <CloudAgentHeldMark worktreeId="gudgeon" />
    </div>
  )
}

const markFixture = (scenario: Scenario) =>
  defineFixture({
    width: 340,
    render: () => {
      seed(scenario)
      return (
        <div className="h-[110px] p-3">
          <Row />
        </div>
      )
    },
    interact: async (frame: HTMLElement) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const mark = frame.querySelector<HTMLElement>('[data-cloud-agent-held]')
      mark?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      mark?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 900))
    }
  })

export const sidebarRowMark = markFixture('notSetUp')
/**
 * V3-01: a launch put back after a restart that only waits for Start: the muted play mark, never
 * the amber key (the account here is covered: no "not set up").
 */
export const sidebarRowMarkNotStarted = markFixture('restored')
/** HELD-STALE-COVERED: set up in this session, waiting for Start: muted play (not the amber key). */
export const sidebarRowMarkSetUp = markFixture('setUp')
/** HELD-STALE-COVERED: the sign-in was revoked under the hold: the key, "sign-in expired". */
export const sidebarRowMarkExpired = markFixture('expired')
