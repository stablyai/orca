// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY } from '../../../../shared/host-gated-ui-fields'

const runtime = vi.hoisted(() => ({
  callRuntimeResult: vi.fn(),
  getRemoteRuntimeStatus: vi.fn()
}))

vi.mock('./web-runtime-calls', () => runtime)
vi.mock('./web-runtime-session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireActiveEnvironmentOrNull: () => ({ id: 'env-1' })
}))

import { createWebUiApi, resetHostUiCapabilitiesForTest } from './web-ui-api'

function sentUiSetPayloads(): unknown[] {
  return runtime.callRuntimeResult.mock.calls
    .filter(([method]) => method === 'ui.set')
    .map(([, params]) => params)
}

describe('web ui.set host-gated keys', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetHostUiCapabilitiesForTest()
    runtime.callRuntimeResult.mockReset().mockResolvedValue(undefined)
    runtime.getRemoteRuntimeStatus.mockReset()
  })

  it('strips the session grid keys when the paired host has not advertised them', async () => {
    runtime.getRemoteRuntimeStatus.mockResolvedValue({ capabilities: ['runtime.status.compat.v1'] })
    await createWebUiApi().setWithAck!({ sidebarWidth: 300, sessionsGridZoom: 1.2 })
    expect(sentUiSetPayloads()).toEqual([{ sidebarWidth: 300 }])
  })

  it('sends them once the host advertises the capability', async () => {
    runtime.getRemoteRuntimeStatus.mockResolvedValue({
      capabilities: [SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY]
    })
    await createWebUiApi().setWithAck!({ sidebarWidth: 300, sessionsGridZoom: 1.2 })
    expect(sentUiSetPayloads()).toEqual([{ sidebarWidth: 300, sessionsGridZoom: 1.2 }])
  })

  it('strips them when the host cannot be asked, so the batch-mates still land', async () => {
    runtime.getRemoteRuntimeStatus.mockRejectedValue(new Error('offline'))
    await createWebUiApi().set({ sidebarWidth: 300, sessionsGridTabOrder: ['a'] })
    expect(sentUiSetPayloads()).toEqual([{ sidebarWidth: 300 }])
  })

  it('never asks the host for a write that carries no gated key', async () => {
    await createWebUiApi().setWithAck!({ sidebarWidth: 300 })
    expect(runtime.getRemoteRuntimeStatus).not.toHaveBeenCalled()
    expect(sentUiSetPayloads()).toEqual([{ sidebarWidth: 300 }])
  })

  it('reuses the advertised list across writes to the same host', async () => {
    runtime.getRemoteRuntimeStatus.mockResolvedValue({
      capabilities: [SESSION_GRID_UI_FIELDS_RUNTIME_CAPABILITY]
    })
    const api = createWebUiApi()
    await api.setWithAck!({ sessionsGridZoom: 1.1 })
    await api.setWithAck!({ sessionsGridZoom: 1.2 })
    expect(runtime.getRemoteRuntimeStatus).toHaveBeenCalledTimes(1)
    expect(sentUiSetPayloads()).toEqual([{ sessionsGridZoom: 1.1 }, { sessionsGridZoom: 1.2 }])
  })

  it('keeps stripping pairing-local keys alongside the gate', async () => {
    runtime.getRemoteRuntimeStatus.mockResolvedValue({ capabilities: [] })
    await createWebUiApi().setWithAck!({
      sidebarWidth: 300,
      sessionsGridFilter: 'all',
      manualRepoOrder: []
    })
    expect(sentUiSetPayloads()).toEqual([{ sidebarWidth: 300 }])
  })
})
