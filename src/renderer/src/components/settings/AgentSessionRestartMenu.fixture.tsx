import { defineFixture } from '../../component-fixtures/component-fixture'
import { AgentSessionRestartMenuView } from './AgentSessionRestartMenu'

const rows = [
  { agent: 'claude' as const, label: 'Claude', liveCount: 2, disabled: false },
  { agent: 'codex' as const, label: 'Codex', liveCount: 0, disabled: true },
  { agent: 'grok' as const, label: 'Grok', liveCount: 1, disabled: false },
  { agent: 'trae' as const, label: 'Trae', liveCount: 1, disabled: false }
]

export const results = defineFixture({
  width: 420,
  interact: (frame) => {
    const trigger = frame.querySelector<HTMLButtonElement>(
      '[data-testid="agent-session-restart-trigger"]'
    )
    const pointer = { bubbles: true, cancelable: true }
    trigger?.dispatchEvent(new PointerEvent('pointerdown', pointer))
    trigger?.dispatchEvent(new PointerEvent('pointerup', pointer))
    trigger?.click()
  },
  render: () => (
    <AgentSessionRestartMenuView
      rows={rows}
      restartAllCount={4}
      running={false}
      hostNote="This computer cannot replace agents on another host, so those sessions were left running."
      menuOpen
      onRestart={() => {}}
      outcomes={[
        {
          ptyId: 'pty-queued',
          agent: 'claude',
          label: 'Claude',
          workspaceLabel: 'repo',
          status: 'queued',
          message: 'waiting until it is idle',
          newPtyId: null,
          reapPtyId: null
        },
        {
          ptyId: 'pty-trae',
          agent: 'trae',
          label: 'Trae',
          workspaceLabel: 'repo',
          status: 'skipped',
          message: 'this CLI cannot resume a session',
          newPtyId: null,
          reapPtyId: null
        },
        {
          ptyId: 'pty-grok',
          agent: 'grok',
          label: 'Grok',
          workspaceLabel: 'repo',
          status: 'succeeded',
          message: 'new process started with original session resume command',
          newPtyId: 'pty-new',
          reapPtyId: null
        }
      ]}
    />
  )
})
