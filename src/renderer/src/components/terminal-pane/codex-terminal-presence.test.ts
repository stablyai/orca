import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { applyAgentStatusPatch } from '@/store/agent-status-patch'
import { makeTab } from '@/store/slices/store-test-helpers'
import { whenCodexTerminalAppears } from './codex-terminal-presence'

const owner = getAgentStatusOwner(useAppStore)
let original = owner.getState()
const stops: (() => void)[] = []
beforeEach(() => {
  original = owner.getState()
  applyAgentStatusPatch(useAppStore, {
    tabsByWorktree: {},
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {}
  })
})
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  applyAgentStatusPatch(useAppStore, original)
})
const tab = (agent: 'codex' | 'claude') =>
  makeTab({ id: 'tab-1', worktreeId: 'wt-1', launchAgent: agent })

describe('whenCodexTerminalAppears', () => {
  it.each(['launched', 'hook', 'foreground'] as const)('calls back once for %s Codex', (kind) => {
    const onAppear = vi.fn()
    stops.push(whenCodexTerminalAppears(onAppear))
    if (kind === 'launched') {
      useAppStore.setState({ tabsByWorktree: { 'wt-1': [tab('codex')] } })
    } else if (kind === 'foreground') {
      useAppStore
        .getState()
        .setPaneForegroundAgent('tab-1:leaf', { agent: 'codex', shellForeground: false })
    } else {
      owner.transact((transaction) =>
        transaction.setEntry('tab-1:leaf', {
          paneKey: 'tab-1:leaf',
          agentType: 'codex',
          state: 'working',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: []
        })
      )
    }
    useAppStore.setState({ tabsByWorktree: { 'wt-2': [tab('codex')] } })
    expect(onAppear).toHaveBeenCalledTimes(1)
  })
  it('calls back at once when a Codex terminal already exists', () => {
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [tab('codex')] } })
    const onAppear = vi.fn()
    stops.push(whenCodexTerminalAppears(onAppear))
    expect(onAppear).toHaveBeenCalledTimes(1)
  })
  it('ignores other agents', () => {
    const onAppear = vi.fn()
    stops.push(whenCodexTerminalAppears(onAppear))
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [tab('claude')] } })
    owner.transact((transaction) =>
      transaction.setEntry('tab-1:leaf', {
        paneKey: 'tab-1:leaf',
        agentType: 'claude',
        state: 'working',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: []
      })
    )
    useAppStore
      .getState()
      .setPaneForegroundAgent('tab-1:leaf', { agent: 'opencode', shellForeground: false })
    expect(onAppear).not.toHaveBeenCalled()
  })
  it('stops watching once unsubscribed', () => {
    const onAppear = vi.fn()
    whenCodexTerminalAppears(onAppear)()
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [tab('codex')] } })
    expect(onAppear).not.toHaveBeenCalled()
  })
})
