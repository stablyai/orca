import { Cloud } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { holdCloudAgentLaunch } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { setOrcaCloudAgentAccountsStateForTest } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { CloudAgentHeldMark } from './CloudAgentHeldMark'

// A cloud workspace row whose Claude waits on its pane's "Set up once" strip (N-03).
function seed(): void {
  setOrcaCloudAgentAccountsStateForTest({
    load: {
      kind: 'ready',
      status: {
        credentials: {
          claude: { state: 'none' },
          codex: { state: 'none' },
          providerEnabled: { claude: true, codex: true }
        },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  })
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mark reads only tab ids
    tabsByWorktree: { gudgeon: [{ id: 'web-terminal-g' }] } as never
  })
  void holdCloudAgentLaunch({
    decided: true,
    paneKey: 'tab:web-terminal-g',
    agent: 'claude',
    prompt: null
  })
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

export const sidebarRowMark = defineFixture({
  width: 340,
  render: () => {
    seed()
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
