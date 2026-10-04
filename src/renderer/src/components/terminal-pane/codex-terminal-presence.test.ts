import { beforeEach, describe, expect, it, vi } from 'vitest'
import { noticeTestStore } from './codex-notice-test-harness'
import { whenCodexTerminalAppears } from './codex-terminal-presence'

vi.mock('@/store', () => import('./codex-notice-test-harness'))

describe('whenCodexTerminalAppears', () => {
  beforeEach(() => {
    noticeTestStore.setState(
      { tabsByWorktree: {}, agentStatusByPaneKey: {}, paneForegroundAgentByPaneKey: {} },
      true
    )
  })

  it.each([
    ['an Orca-launched Codex tab', { tabsByWorktree: { 'wt-1': [{ launchAgent: 'codex' }] } }],
    ['a hook-reported Codex', { agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'codex' } } }],
    [
      'a typed codex in the foreground',
      { paneForegroundAgentByPaneKey: { 'tab-1:leaf': { agent: 'codex' } } }
    ]
  ])('calls back once for %s', (_name, patch) => {
    const onAppear = vi.fn()
    whenCodexTerminalAppears(onAppear)

    noticeTestStore.setState(patch)
    noticeTestStore.setState({ tabsByWorktree: { 'wt-2': [{ launchAgent: 'codex' }] } })

    expect(onAppear).toHaveBeenCalledTimes(1)
  })

  it('calls back at once when a Codex terminal already exists', () => {
    noticeTestStore.setState({ tabsByWorktree: { 'wt-1': [{ launchAgent: 'codex' }] } })
    const onAppear = vi.fn()
    whenCodexTerminalAppears(onAppear)
    expect(onAppear).toHaveBeenCalledTimes(1)
  })

  it('ignores other agents', () => {
    const onAppear = vi.fn()
    whenCodexTerminalAppears(onAppear)
    noticeTestStore.setState({
      tabsByWorktree: { 'wt-1': [{ launchAgent: 'claude' }] },
      agentStatusByPaneKey: { 'tab-1:leaf': { agentType: 'claude' } },
      paneForegroundAgentByPaneKey: { 'tab-1:leaf': { agent: 'opencode' } }
    })
    expect(onAppear).not.toHaveBeenCalled()
  })

  it('stops watching once unsubscribed', () => {
    const onAppear = vi.fn()
    whenCodexTerminalAppears(onAppear)()
    noticeTestStore.setState({ tabsByWorktree: { 'wt-1': [{ launchAgent: 'codex' }] } })
    expect(onAppear).not.toHaveBeenCalled()
  })
})
