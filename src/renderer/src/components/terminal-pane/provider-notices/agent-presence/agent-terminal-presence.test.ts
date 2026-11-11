import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeTerminalTab } from '@/store/terminals/terminal-row.test-fixture'
import { status } from '@/components/native-chat/messages/agent-senders/native-chat-agent-sender.test-fixture'
import { whenAgentTerminalAppears } from './agent-terminal-presence'

const initial = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initial, true)
})

describe('whenAgentTerminalAppears', () => {
  it('ignores a Claude status entry from a native chat tab', () => {
    const onAppear = vi.fn()
    useAppStore.setState({
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {}
    })
    const unsubscribe = whenAgentTerminalAppears('claude', onAppear)
    const entry = status(1)
    useAppStore.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
    expect(onAppear).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('fires for a Claude status entry from a terminal tab', () => {
    const onAppear = vi.fn()
    useAppStore.setState({
      tabsByWorktree: { workspace: [makeTerminalTab({ id: 'tab-1', worktreeId: 'workspace' })] },
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {}
    })
    whenAgentTerminalAppears('claude', onAppear)
    const entry = status(1)
    useAppStore.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
    expect(onAppear).toHaveBeenCalledTimes(1)
  })
})
