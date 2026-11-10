import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_ENVIRONMENT_WAKING_MESSAGE } from '../../../../../shared/remote-runtime/recipe-vm-wake'

const call = vi.hoisted(() => vi.fn())

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../../../lib/workspace/ownership/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => 'env-1'
}))
vi.mock('../../web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => true,
  captureRuntimeEnvironmentCall: () => call
}))
vi.mock('../../web-session-tabs-sync/frame-drawn-server-workspace-set', () => ({
  isServerFrameDrawnWorkspace: () => false
}))

import {
  PANE_LAYOUT_WAKING_SENDS,
  updateWebRuntimePaneLayout
} from './web-runtime-pane-layout-update'

const waking = new Error(`RemoteRuntimeClientError: ${RUNTIME_ENVIRONMENT_WAKING_MESSAGE}`)
const ok = { ok: true, result: { updated: true }, _meta: { runtimeId: 'r' } }
const push = (tabId = 'tab-1') =>
  updateWebRuntimePaneLayout({ worktreeId: 'wt', tabId, root: null, expandedLeafId: null })

describe('pane layout push while the VM wakes', () => {
  beforeEach(() => {
    call.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('sends again when refused as still waking, until it lands', async () => {
    call.mockRejectedValueOnce(waking).mockRejectedValueOnce(waking).mockResolvedValue(ok)
    await expect(push()).resolves.toBe(true)
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('gives up after a bounded number of sends, and never retries other failures', async () => {
    call.mockRejectedValue(waking)
    await expect(push()).resolves.toBe(false)
    expect(call).toHaveBeenCalledTimes(PANE_LAYOUT_WAKING_SENDS)
    call.mockReset()
    call.mockRejectedValue(new Error('forbidden'))
    await expect(push()).resolves.toBe(false)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('drops a retry a newer push for the same tab has replaced', async () => {
    let releaseFirst: (value: unknown) => void = () => {}
    call
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => (releaseFirst = () => reject(waking)))
      )
      .mockResolvedValue(ok)
    const first = push()
    await expect(push()).resolves.toBe(true)
    releaseFirst(undefined)
    await expect(first).resolves.toBe(false)
    // The older layout was not sent again over the newer one.
    expect(call).toHaveBeenCalledTimes(2)
  })
})
