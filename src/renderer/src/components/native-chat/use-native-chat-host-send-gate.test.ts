// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatHostPermissionGate } from './use-native-chat-host-permission-gate'
import type { NativeChatHostOutage } from './use-native-chat-host-outage'

const permission = vi.hoisted(() => {
  const gate: NativeChatHostPermissionGate = { sendBlockedReason: null, notice: null }
  return { gate }
})
vi.mock('./use-native-chat-host-permission-gate', () => ({
  useNativeChatHostPermissionGate: () => permission.gate
}))

import { useNativeChatHostSendGate } from './use-native-chat-host-send-gate'

const target = { kind: 'environment', environmentId: 'wsl:ubuntu' } as const

function outage(kind: NativeChatHostOutage['kind']): NativeChatHostOutage {
  return { kind, environmentId: 'wsl:ubuntu', hostLabel: 'Ubuntu', canReconnect: true }
}

afterEach(() => {
  permission.gate = { sendBlockedReason: null, notice: null }
})

it('holds Send on a stopped WSL distro, saying Start comes first', () => {
  const gate = renderHook(() => useNativeChatHostSendGate(target, 'claude', outage('stopped')))
  expect(gate.result.current.sendBlockedReason).toBe('Start Ubuntu to send.')
})

it.each(['offline', 'reconnecting'] as const)('leaves Send to the host while it is %s', (kind) => {
  const gate = renderHook(() => useNativeChatHostSendGate(target, 'claude', outage(kind)))
  expect(gate.result.current.sendBlockedReason).toBeNull()
})

it("keeps the host permission check's own reason and notice first", () => {
  permission.gate = { sendBlockedReason: "Checking this host's chat permissions…", notice: null }
  const gate = renderHook(() => useNativeChatHostSendGate(target, 'claude', outage('stopped')))
  expect(gate.result.current).toBe(permission.gate)
})
