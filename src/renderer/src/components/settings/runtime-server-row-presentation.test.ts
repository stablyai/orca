import { describe, expect, it } from 'vitest'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import {
  formatRuntimeEndpointAddress,
  getRuntimeServerAvailableUpdateText,
  getRuntimeServerStatusIndicator,
  getRuntimeServerVersionText,
  type RuntimeServerStatusInput
} from './runtime-server-row-presentation'

function updateEntry(patch: Partial<RemoteServerUpdateEntry>): RemoteServerUpdateEntry {
  return {
    environmentId: 'env-a',
    name: 'm4air',
    phase: 'offline',
    currentVersion: null,
    targetVersion: null,
    progress: null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: null,
    ...patch
  }
}

function statusInput(patch: Partial<RuntimeServerStatusInput>): RuntimeServerStatusInput {
  return {
    connectionState: 'disconnected',
    accessRevoked: false,
    compatibilityBlocked: false,
    probeFailed: false,
    connecting: false,
    disconnecting: false,
    remoteUpdate: undefined,
    ...patch
  }
}

describe('runtime server status indicator', () => {
  it('names a revoked host as revoked, not disconnected', () => {
    expect(getRuntimeServerStatusIndicator(statusInput({ accessRevoked: true }))).toEqual({
      label: 'Access revoked',
      tone: 'destructive'
    })
  })

  it('says unreachable, not offline, when the probe got no answer', () => {
    expect(getRuntimeServerStatusIndicator(statusInput({ probeFailed: true })).label).toBe(
      'Unreachable'
    )
    expect(getRuntimeServerStatusIndicator(statusInput({})).label).toBe('Disconnected')
  })

  it('keeps the connection label otherwise', () => {
    expect(getRuntimeServerStatusIndicator(statusInput({ connectionState: 'connected' }))).toEqual({
      label: 'Connected',
      tone: 'success'
    })
    expect(getRuntimeServerStatusIndicator(statusInput({ connectionState: 'checking' }))).toEqual({
      label: 'Checking…',
      tone: 'muted',
      busy: true
    })
  })

  it('shows the update stage while an update runs', () => {
    expect(
      getRuntimeServerStatusIndicator(
        statusInput({
          connectionState: 'connected',
          remoteUpdate: updateEntry({ phase: 'downloading' })
        })
      ).label
    ).toBe('Downloading…')
  })

  it('flags an incompatible server as needing an update', () => {
    expect(getRuntimeServerStatusIndicator(statusInput({ compatibilityBlocked: true }))).toEqual({
      label: 'Needs update',
      tone: 'destructive'
    })
  })
})

describe('managed server not running', () => {
  it('says Not running only when nothing more specific applies', () => {
    expect(getRuntimeServerStatusIndicator(statusInput({ managedNotRunning: true })).label).toBe(
      'Not running'
    )
    expect(
      getRuntimeServerStatusIndicator(statusInput({ managedNotRunning: true, connecting: true }))
        .label
    ).toBe('Connecting…')
    expect(
      getRuntimeServerStatusIndicator(statusInput({ managedNotRunning: true, accessRevoked: true }))
        .label
    ).toBe('Access revoked')
    expect(
      getRuntimeServerStatusIndicator(
        statusInput({ managedNotRunning: true, compatibilityBlocked: true })
      ).label
    ).toBe('Needs update')
    expect(
      getRuntimeServerStatusIndicator(
        statusInput({ managedNotRunning: true, remoteUpdate: updateEntry({ phase: 'restarting' }) })
      ).label
    ).toBe('Restarting…')
  })
})

describe('runtime server meta line', () => {
  it('falls back to the last verified version when the probe failed', () => {
    expect(getRuntimeServerVersionText(updateEntry({}), '1.4.229')).toBe('v1.4.229')
    expect(getRuntimeServerVersionText(updateEntry({}), null)).toBeNull()
    expect(getRuntimeServerVersionText(updateEntry({ currentVersion: '1.5.0' }), '1.4.0')).toBe(
      'v1.5.0'
    )
  })

  it('names the available version only for an available update', () => {
    expect(
      getRuntimeServerAvailableUpdateText(
        updateEntry({ phase: 'available', targetVersion: '1.9.2' })
      )
    ).toBe('v1.9.2 available')
    expect(getRuntimeServerAvailableUpdateText(updateEntry({ phase: 'current' }))).toBeNull()
  })

  it('shows host:port for a ws endpoint', () => {
    expect(formatRuntimeEndpointAddress('ws://100.88.1.4:6768')).toBe('100.88.1.4:6768')
    expect(formatRuntimeEndpointAddress('not a url')).toBe('not a url')
    expect(formatRuntimeEndpointAddress(undefined)).toBeNull()
  })
})
