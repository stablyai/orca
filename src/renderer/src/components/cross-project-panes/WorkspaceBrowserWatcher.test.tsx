// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceBrowserWatcher } from './WorkspaceBrowserWatcher'
import {
  encodeBrowserScreencastFrame,
  BrowserScreencastOpcode
} from '../../../../shared/browser-screencast-protocol'
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({ runtimeId: 'local-runtime' }))
}))
vi.mock('@/runtime/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => 7
}))
afterEach(cleanup)
it('watches the existing guest frame without viewport or input commands', async () => {
  const unsubscribe = vi.fn()
  const subscribeBrowser = vi.fn(async (_request, callbacks) => {
    callbacks.onBinary(
      encodeBrowserScreencastFrame({
        opcode: BrowserScreencastOpcode.Frame,
        seq: 1,
        format: 'png',
        metadata: {},
        image: new Uint8Array([1, 2, 3])
      })
    )
    return { unsubscribe }
  })
  Object.assign(window, { orcaWorkspaceViews: { subscribeBrowser } })
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:frame', revokeObjectURL: vi.fn() })
  const mounted = render(<WorkspaceBrowserWatcher pageId="existing-page" worktreeId="project" />)
  expect(await screen.findByAltText('Shared browser view')).toBeTruthy()
  expect(subscribeBrowser.mock.calls[0][0]).toEqual({
    runtimeId: 'local-runtime',
    params: { page: 'existing-page', worktree: 'id:project', format: 'jpeg' }
  })
  mounted.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  vi.unstubAllGlobals()
})

it('routes loopback frames through the environment bridge and releases a late subscription', async () => {
  let resolve!: (value: { unsubscribe: () => void }) => void
  const subscribe = vi.fn(
    (_request: unknown) =>
      new Promise<{ unsubscribe: () => void }>((done) => {
        resolve = done
      })
  )
  Object.assign(window, { api: { runtimeEnvironments: { subscribe } } })
  const mounted = render(
    <WorkspaceBrowserWatcher pageId="page" worktreeId="project" environmentId="web-loopback" />
  )
  expect(subscribe.mock.calls[0][0]).toEqual({
    selector: 'web-loopback',
    method: 'browser.screencast',
    params: { page: 'page', worktree: 'id:project', format: 'jpeg' },
    expectedEnvironmentPairingRevision: 7
  })
  mounted.unmount()
  const unsubscribe = vi.fn()
  await act(async () => resolve({ unsubscribe }))
  expect(unsubscribe).toHaveBeenCalledOnce()
})
