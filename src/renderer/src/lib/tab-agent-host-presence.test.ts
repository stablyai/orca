import { selectFocusedPanePresence } from './agent-presence-selectors'
import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals } from './tab-agent-from-signals'

const agentPresence = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:123' }
} as const
const signals = {
  hasObservedAgentSignal: true,
  isRemote: false,
  title: 'zsh',
  hookAgent: null,
  processShellForeground: true,
  launchAgent: 'codex'
} as const

describe('host ownership takes precedence over desktop signals', () => {
  it('keeps an identified idle owner through a shell title and foreground read', () => {
    expect(resolveTabAgentFromSignals({ ...signals, agentPresence })).toBe('claude')
  })
  it('removes an exited owner despite stale hook, title, process and launch hints', () => {
    expect(
      resolveTabAgentFromSignals({
        ...signals,
        title: 'claude',
        hookAgent: 'claude',
        processAgent: 'claude',
        agentPresence: { ...agentPresence, ended: true }
      })
    ).toBeNull()
  })
  it('keeps the temporary compatibility behavior when the host has no process identity', () => {
    expect(
      resolveTabAgentFromSignals({ ...signals, agentPresence: { agent: 'claude' } })
    ).toBeNull()
  })
  it('reads only the focused pane, and the only record while the layout hydrates', () => {
    const focused = 'tab:11111111-1111-4111-8111-111111111111'
    const sibling = 'tab:22222222-2222-4222-8222-222222222222'
    const ended = { ...agentPresence, ended: true } as const
    const records = {
      [focused]: { presence: ended, receivedAt: 1 },
      [sibling]: { presence: agentPresence, receivedAt: 2 }
    }
    expect(selectFocusedPanePresence(records, 'tab', focused)).toBe(ended)
    expect(selectFocusedPanePresence(records, 'tab', null)).toBeUndefined()
    expect(selectFocusedPanePresence({ [focused]: records[focused] }, 'tab', null)).toBe(ended)
  })
})
