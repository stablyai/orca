// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import { useDetectedAgents, type UseDetectedAgentsResult } from './useDetectedAgents'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const detectRemoteAgents = vi.fn()
const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []
let latest: UseDetectedAgentsResult | null = null

function HookProbe(): null {
  latest = useDetectedAgents({ kind: 'ssh', connectionId: 'ssh-1' })
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setSshStatus(status: SshConnectionStatus): void {
  useAppStore.getState().setSshConnectionState('ssh-1', {
    targetId: 'ssh-1',
    status,
    error: null,
    reconnectAttempt: 0
  })
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  latest = null
  detectRemoteAgents.mockReset()
  Object.defineProperty(globalThis.window, 'api', {
    configurable: true,
    value: {
      preflight: { detectAgents: vi.fn(), detectRemoteAgents, refreshAgents: vi.fn() }
    }
  })
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
})

// verify checklist: "Couldn't list terminal agents" stayed after the SSH host came back.
describe('useDetectedAgents when the SSH host reconnects', () => {
  it('re-lists agents once the connection returns after a failed probe, and not while it is down', async () => {
    let hostUp = false
    detectRemoteAgents.mockImplementation(() =>
      hostUp ? Promise.resolve(['codex']) : Promise.reject(new Error('SSH connection lost'))
    )
    setSshStatus('disconnected')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(createElement(HookProbe))
    })
    await flushEffects()
    expect(latest?.detectionFailed).toBe(true)
    const failedCalls = detectRemoteAgents.mock.calls.length

    // Reconnect attempts are not a reconnect: the host is not probed until it is back.
    await act(async () => {
      setSshStatus('reconnecting')
    })
    await flushEffects()
    expect(detectRemoteAgents).toHaveBeenCalledTimes(failedCalls)

    hostUp = true
    await act(async () => {
      setSshStatus('connected')
    })
    await flushEffects()
    await flushEffects()

    expect(detectRemoteAgents).toHaveBeenCalledTimes(failedCalls + 1)
    expect(latest?.detectedIds).toEqual(['codex'])
    expect(latest?.detectionFailed).toBe(false)
  })

  it('probes a connection that has reported no state yet, as before', async () => {
    detectRemoteAgents.mockResolvedValue(['claude'])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(createElement(HookProbe))
    })
    await flushEffects()
    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
    expect(latest?.detectedIds).toEqual(['claude'])
  })
})
