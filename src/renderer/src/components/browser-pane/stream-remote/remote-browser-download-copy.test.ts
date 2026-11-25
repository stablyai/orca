// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), loading: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
  copyServerDownload: vi.fn(),
  cancelServerDownloadCopy: vi.fn()
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => undefined
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn(async () => {}) }))
vi.mock('@/lib/files/os-open/local-file-manager-label', () => ({
  getLocalFileManager: () => 'finder'
}))

import { offerRemoteBrowserDownloadCopy } from './remote-browser-download-copy'

type Clickable = { action: { onClick: (event: { preventDefault: () => void }) => void } }
const click = (options: unknown): void =>
  (options as Clickable).action.onClick({ preventDefault: () => {} })

type AckOrder = 'ack-before-result' | 'result-before-ack'

/**
 * Clicks Save to this computer, then Cancel (which main accepts), and lets the copy end with
 * `outcome`, with main's reply to the Cancel arriving before or after the copy's own.
 */
async function saveThenCancel(outcome: { canceled: true } | Error, order: AckOrder): Promise<void> {
  let settle: () => void = () => {}
  mocks.copyServerDownload.mockReturnValue(
    new Promise((resolve, reject) => {
      // What crosses IPC is a structured clone.
      settle = () =>
        outcome instanceof Error ? reject(outcome) : resolve(structuredClone(outcome))
    })
  )
  let ack: () => void = () => {}
  mocks.cancelServerDownloadCopy.mockReturnValue(
    new Promise<boolean>((resolve) => {
      ack = () => resolve(true)
    })
  )
  offerRemoteBrowserDownloadCopy({
    toastId: 'toast',
    target: { kind: 'environment', environmentId: 'server' },
    copyId: 'copy',
    savedOnServer: 'Saved on server',
    filename: 'report.pdf'
  })
  click(mocks.toast.success.mock.calls[0][1])
  click(mocks.toast.loading.mock.calls[0][1])
  expect(mocks.cancelServerDownloadCopy).toHaveBeenCalledWith({ copyId: 'copy' })
  if (order === 'ack-before-result') {
    ack()
    await Promise.resolve()
  }
  settle()
  await vi.waitFor(() =>
    expect(mocks.toast.error.mock.calls.length + mocks.toast.dismiss.mock.calls.length).toBe(1)
  )
  ack()
}

beforeEach(() => {
  Object.assign(window, {
    api: {
      browser: {
        copyServerDownload: mocks.copyServerDownload,
        cancelServerDownloadCopy: mocks.cancelServerDownloadCopy
      }
    }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

const ORDERS: AckOrder[] = ['ack-before-result', 'result-before-ack']

describe('Cancel on a download being saved to this computer', () => {
  it.each(ORDERS)('closes the toast when main says Cancel stopped the copy (%s)', async (order) => {
    await saveThenCancel({ canceled: true }, order)

    expect(mocks.toast.dismiss).toHaveBeenCalledWith('toast')
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it.each(ORDERS)(
    'still shows a real failure that ended the copy after Cancel was accepted (%s)',
    async (order) => {
      const failure = new Error('EIO: i/o error, close')
      await saveThenCancel(failure, order)

      expect(mocks.toast.dismiss).not.toHaveBeenCalled()
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "Couldn't save {{filename}} to this computer.",
        expect.objectContaining({ description: failure.message })
      )
    }
  )
})
