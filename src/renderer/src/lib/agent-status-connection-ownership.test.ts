import { describe, expect, it } from 'vitest'

import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  resolveAgentStatusConnectionRouting,
  resolveLiveAgentStatusConnectionRouting
} from './agent-status-connection-ownership'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

describe('agent status connection ownership', () => {
  it('uses exact SSH PTY ownership and rejects contradictory routing', () => {
    const ptyId = toAppSshPtyId('ssh-a', 'pty-1')

    expect(resolveAgentStatusConnectionRouting({ ptyId, expectedConnectionId: 'ssh-a' })).toEqual({
      connectionId: 'ssh-a'
    })
    expect(
      resolveAgentStatusConnectionRouting({ ptyId, expectedConnectionId: 'ssh-b' })
    ).toBeUndefined()
    expect(
      resolveAgentStatusConnectionRouting({ ptyId, expectedConnectionId: null })
    ).toBeUndefined()
    expect(resolveAgentStatusConnectionRouting({ ptyId: 'ssh:ssh-a@broken' })).toBeUndefined()
  })

  it('marks known local, WSL, and remote-runtime PTYs as non-SSH', () => {
    expect(
      resolveAgentStatusConnectionRouting({ ptyId: 'pty-local-1', expectedConnectionId: null })
    ).toEqual({ connectionId: null })
    expect(
      resolveAgentStatusConnectionRouting({ ptyId: 'pty-wsl-1', expectedConnectionId: null })
    ).toEqual({ connectionId: null })
    expect(
      resolveAgentStatusConnectionRouting({
        ptyId: 'remote:env-a@@terminal-1',
        expectedConnectionId: null,
        runtimeEnvironmentId: 'env-a'
      })
    ).toEqual({ connectionId: null })
  })

  it('fails closed for missing, malformed, and cross-runtime ownership', () => {
    expect(resolveAgentStatusConnectionRouting({ ptyId: null })).toBeUndefined()
    expect(resolveAgentStatusConnectionRouting({ ptyId: 'remote:' })).toBeUndefined()
    expect(
      resolveAgentStatusConnectionRouting({
        ptyId: 'remote:env-a@@terminal-1',
        expectedConnectionId: 'ssh-a',
        runtimeEnvironmentId: 'env-a'
      })
    ).toBeUndefined()
    expect(
      resolveAgentStatusConnectionRouting({
        ptyId: 'remote:env-a@@terminal-1',
        expectedConnectionId: null,
        runtimeEnvironmentId: 'env-b'
      })
    ).toBeUndefined()
  })

  it('requires one exact live pane binding', () => {
    const ptyId = toAppSshPtyId('ssh-a', 'pty-1')
    const state = {
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: ptyId } } },
      ptyIdsByTabId: { 'tab-1': [ptyId] },
      sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]]),
      transientClearedAgentStatusConnectionIds: {}
    }

    expect(resolveLiveAgentStatusConnectionRouting({ state, paneKey: PANE, ptyId })).toEqual({
      connectionId: 'ssh-a'
    })
    state.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId[LEAF] = toAppSshPtyId('ssh-b', 'pty-1')
    expect(resolveLiveAgentStatusConnectionRouting({ state, paneKey: PANE, ptyId })).toBeUndefined()
  })

  it('rejects stale SSH routing after clear and throughout transient reconnect', () => {
    const ptyId = toAppSshPtyId('ssh-a', 'pty-1')
    const state = {
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF]: ptyId } } },
      ptyIdsByTabId: { 'tab-1': [ptyId] },
      sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]]),
      transientClearedAgentStatusConnectionIds: { 'ssh-a': true } as Record<string, true>
    }

    expect(resolveLiveAgentStatusConnectionRouting({ state, paneKey: PANE, ptyId })).toBeUndefined()
    state.transientClearedAgentStatusConnectionIds = {}
    state.sshConnectionStates = new Map([['ssh-a', { status: 'reconnecting' }]])
    expect(resolveLiveAgentStatusConnectionRouting({ state, paneKey: PANE, ptyId })).toBeUndefined()
  })
})
