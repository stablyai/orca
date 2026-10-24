import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store/types'
import type { TerminalInterfaceObservation } from '../../../../shared/terminal-interface-observation'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { useAppStore } from '@/store'
import {
  applyTerminalInterfaceSnapshot,
  nativeChatShellForeground,
  registerTerminalInterfacePresentation
} from './terminal-interface-presentation'

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({ terminalInterfaceByPtyId: {}, terminalLayoutsByTabId: {} }))
  }
})
const leaf = '11111111-1111-4111-8111-111111111111'
const observation: TerminalInterfaceObservation = {
  ptyId: 'physical-host-pty',
  incarnationId: 'birth',
  terminalHandle: 'opaque-handle',
  paneKey: `host-tab:${leaf}`,
  worktreeId: 'folder:one',
  epoch: 'replica-flow',
  revision: 1,
  inputRevision: 0,
  owner: null,
  executionLaunchToken: null,
  state: 'shell',
  basis: 'process'
}
const releases: (() => void)[] = []
afterEach(() => releases.splice(0).forEach((release) => release()))
describe('terminal-interface paired replica', () => {
  it('joins by handle before row arrival, survives reconnect, follows pane remapping, and retracts an empty snapshot', () => {
    const tabId = toWebTerminalSurfaceTabId('host-tab')
    const paneKey = `${tabId}:${leaf}`
    const ptyId = toRemoteRuntimePtyId('opaque-handle', 'host')
    useAppStore.setState({
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: ptyId }
        }
      }
    })
    const snapshot = {
      type: 'terminalInterfaces',
      epoch: observation.epoch,
      revision: 1,
      observations: [observation]
    }
    applyTerminalInterfaceSnapshot(snapshot, 'host')
    expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(true)
    const map = useAppStore.getState().terminalInterfaceByPtyId
    applyTerminalInterfaceSnapshot(snapshot, 'host')
    expect(useAppStore.getState().terminalInterfaceByPtyId).toBe(map)
    expect(map[toRemoteRuntimePtyId(observation.ptyId, 'host')]).toBeUndefined()
    applyTerminalInterfaceSnapshot({ ...snapshot, revision: 2, observations: [] }, 'host')
    expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(false)
    applyTerminalInterfaceSnapshot(snapshot, 'host')
    expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(false)
    applyTerminalInterfaceSnapshot(
      {
        ...snapshot,
        revision: 3,
        observations: [{ ...observation, revision: 3, paneKey: `moved-tab:${leaf}` }]
      },
      'host'
    )
    expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(false)
  })

  it('requires fresh cold proof after an unavailable host snapshot before a pending mount becomes applicable', () => {
    let pending = true
    releases.push(
      registerTerminalInterfacePresentation(observation.paneKey, {
        ptyId: () => observation.ptyId,
        incarnation: () => observation.incarnationId,
        pending: () => pending,
        cold: () => !pending
      })
    )
    const project = (revision: number, state: 'shell' | 'unverifiable') =>
      applyTerminalInterfaceSnapshot(
        {
          type: 'terminalInterfaces',
          epoch: 'pending-cold',
          revision,
          observations: [{ ...observation, epoch: 'pending-cold', revision, state, basis: 'cold' }]
        },
        null
      )
    project(1, 'shell')
    expect(nativeChatShellForeground(useAppStore.getState(), observation.paneKey)).toBe(false)
    project(2, 'unverifiable')
    pending = false
    expect(nativeChatShellForeground(useAppStore.getState(), observation.paneKey)).toBe(false)
    project(3, 'shell')
    expect(nativeChatShellForeground(useAppStore.getState(), observation.paneKey)).toBe(true)
  })

  it('permits only the bounded cold-restored local exception, and re-derives each existing expectation', () => {
    const paneKey = observation.paneKey
    let pending = false
    let cold = true
    releases.push(
      registerTerminalInterfacePresentation(paneKey, {
        ptyId: () => observation.ptyId,
        incarnation: () => observation.incarnationId,
        pending: () => pending,
        cold: () => cold
      })
    )
    applyTerminalInterfaceSnapshot(
      {
        type: 'terminalInterfaces',
        epoch: 'cold-flow',
        revision: 1,
        observations: [{ ...observation, epoch: 'cold-flow', basis: 'cold' }]
      },
      null
    )
    expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(true)
    for (const patch of [
      { pendingStartupByTabId: { 'host-tab': { command: 'sleep 20 && codex' } } },
      { automaticAgentResumeClaimsByTabId: { 'host-tab': 'resume' } },
      { suppressedPtyExitIds: { [observation.ptyId]: true } }
    ]) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: policy reads only presence of these existing claims; no action consumes the test values.
      useAppStore.setState(patch as Partial<AppState>)
      expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(false)
      useAppStore.setState({
        pendingStartupByTabId: {},
        automaticAgentResumeClaimsByTabId: {},
        suppressedPtyExitIds: {}
      })
    }
    pending = true
    expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(false)
    pending = false
    cold = false
    expect(nativeChatShellForeground(useAppStore.getState(), paneKey)).toBe(false)
  })
})
