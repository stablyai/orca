import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { copyCloudWorkspaceLink, shareLinkFor } from './open-cloud-workspace'
import { rememberCloudWorkspaces } from './cloud-workspace-identity'
import { workspace } from './cloud-workspaces.test-fixture'

const writeClipboardText = vi.fn(async (_text: string) => undefined)
const get = vi.fn()
const browserClipboard = vi.fn(async () => {
  throw new DOMException('Document is not focused.', 'NotAllowedError')
})

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { writeClipboardText }, cloudWorkspaces: { get } } })
  // The renderer's own clipboard rejects outside a focused gesture; the copy must not depend on it.
  vi.stubGlobal('navigator', { clipboard: { writeText: browserClipboard } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  writeClipboardText.mockReset()
  writeClipboardText.mockResolvedValue(undefined)
  get.mockReset()
  toast.error.mockClear()
  toast.success.mockClear()
  browserClipboard.mockClear()
})

describe('copy cloud workspace link', () => {
  it('writes the known W-number link through the main-process clipboard', async () => {
    const w = workspace({ number: 544, link: 'orca://cloud/acme/W-544' })
    rememberCloudWorkspaces([w])
    await expect(copyCloudWorkspaceLink(w.id, null, { quiet: true })).resolves.toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('orca://cloud/acme/W-544')
    expect(browserClipboard).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('looks the link up when this device has not seen it, then copies with the chat', async () => {
    const w = workspace({ link: 'orca://cloud/acme/W-7' })
    get.mockResolvedValue({ ok: true, value: w })
    await expect(copyCloudWorkspaceLink(w.id, 's:1')).resolves.toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('orca://cloud/acme/W-7/c/s%3A1')
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('a paired or offline device still copies the sandbox-id link', async () => {
    const w = workspace({})
    get.mockResolvedValue({ ok: false, error: { code: 'forbidden', message: 'no' } })
    await expect(copyCloudWorkspaceLink(w.id)).resolves.toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith(`orca://cloud/w/${w.id}`)
    expect(toast.error).not.toHaveBeenCalled()

    get.mockRejectedValue(new Error('ipc down'))
    await expect(copyCloudWorkspaceLink(w.id)).resolves.toBe(true)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('never rejects when the lookup bridge is missing or hangs', async () => {
    const w = workspace({})
    vi.stubGlobal('window', { api: { ui: { writeClipboardText } } })
    await expect(shareLinkFor(w.id)).resolves.toBe(`orca://cloud/w/${w.id}`)

    vi.useFakeTimers()
    vi.stubGlobal('window', {
      api: { ui: { writeClipboardText }, cloudWorkspaces: { get: () => new Promise(() => {}) } }
    })
    const pending = shareLinkFor(w.id)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toBe(`orca://cloud/w/${w.id}`)
  })

  it('shows the error toast only when the clipboard write itself fails', async () => {
    const w = workspace({ link: 'orca://cloud/acme/W-9' })
    rememberCloudWorkspaces([w])
    writeClipboardText.mockRejectedValueOnce(new Error('clipboard busy'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(copyCloudWorkspaceLink(w.id, null, { quiet: true })).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
