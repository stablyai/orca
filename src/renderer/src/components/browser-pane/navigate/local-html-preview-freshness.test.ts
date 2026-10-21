// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  recordLocalHtmlPreviewNavigation,
  refreshLocalHtmlPreview
} from './local-html-preview-freshness'

const stat = vi.fn()

afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  stat.mockReset()
  stat.mockResolvedValue({ size: 100, mtime: 1, isDirectory: false })
  vi.stubGlobal('window', { api: { fs: { stat } } })
})

function guest() {
  const reloadIgnoringCache = vi.fn()
  const webview = {
    getWebContentsId: () => 1,
    reloadIgnoringCache
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests use only the guest liveness and reload methods.
    webview: webview as unknown as Electron.WebviewTag,
    reloadIgnoringCache
  }
}

function navigate(webview: Electron.WebviewTag, url = 'file:///repo/report.html') {
  recordLocalHtmlPreviewNavigation(webview, { isMainFrame: true, isInPlace: false, url })
}

it('preserves an unchanged page across repeated file opens and in-page navigation', async () => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview)
  recordLocalHtmlPreviewNavigation(webview, {
    isMainFrame: true,
    isInPlace: true,
    url: 'file:///repo/report.html#section'
  })

  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  await refreshLocalHtmlPreview(webview, '/repo/report.html')

  expect(reloadIgnoringCache).not.toHaveBeenCalled()
})

it.each([
  { size: 100, mtime: 2 },
  { size: 120, mtime: 1 }
])('reloads changed disk content once, including regeneration: %j', async (revision) => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview)
  stat.mockResolvedValue({ ...revision, isDirectory: false })

  await Promise.all([
    refreshLocalHtmlPreview(webview, '/repo/report.html'),
    refreshLocalHtmlPreview(webview, '/repo/report.html')
  ])
  await refreshLocalHtmlPreview(webview, '/repo/report.html')

  expect(reloadIgnoringCache).toHaveBeenCalledTimes(1)
})

it('records the new disk revision after a manual reload', async () => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview)
  stat.mockResolvedValue({ size: 100, mtime: 2, isDirectory: false })
  navigate(webview)

  await refreshLocalHtmlPreview(webview, '/repo/report.html')

  expect(reloadIgnoringCache).not.toHaveBeenCalled()
})

it('does not reload another page after navigation during the disk check', async () => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview)
  let finishStat = (_value: { size: number; mtime: number; isDirectory: boolean }): void => {
    throw new Error('Disk check did not start')
  }
  stat.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishStat = resolve
      })
  )
  const refresh = refreshLocalHtmlPreview(webview, '/repo/report.html')
  navigate(webview, 'https://example.com')
  finishStat({ size: 100, mtime: 2, isDirectory: false })
  await refresh

  expect(reloadIgnoringCache).not.toHaveBeenCalled()
})

it('keeps the loaded revision after a failed stat so a later successful open can refresh', async () => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview)
  stat.mockRejectedValueOnce(new Error('Filesystem unavailable'))
  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  expect(reloadIgnoringCache).not.toHaveBeenCalled()

  stat.mockResolvedValue({ size: 100, mtime: 2, isDirectory: false })
  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  expect(reloadIgnoringCache).toHaveBeenCalledOnce()
})

it('refreshes when the initial disk revision was unavailable but a later reopen can read it', async () => {
  const { webview, reloadIgnoringCache } = guest()
  stat.mockRejectedValueOnce(new Error('Filesystem unavailable'))
  navigate(webview)

  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  await refreshLocalHtmlPreview(webview, '/repo/report.html')

  expect(reloadIgnoringCache).toHaveBeenCalledOnce()
})

it('refreshes a directly linked file through explicit access and retains its revision across reloads', async () => {
  const { webview, reloadIgnoringCache } = guest()
  let mtime = 1
  stat.mockImplementation(async ({ access }: { access: { kind: string } }) => {
    if (access.kind === 'document-resource') {
      throw new Error('Symlink target outside the document folder')
    }
    return { size: 100, mtime, isDirectory: false }
  })
  reloadIgnoringCache.mockImplementation(() => navigate(webview))
  navigate(webview)

  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  expect(reloadIgnoringCache).toHaveBeenCalledTimes(1)

  mtime = 2
  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  expect(reloadIgnoringCache).toHaveBeenCalledTimes(2)
})

it('retains a changed revision for retry when the guest is temporarily missing', async () => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview)
  stat.mockResolvedValue({ size: 100, mtime: 2, isDirectory: false })
  vi.spyOn(webview, 'getWebContentsId').mockImplementationOnce(() => {
    throw new Error('Guest missing')
  })

  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  expect(reloadIgnoringCache).not.toHaveBeenCalled()
  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  expect(reloadIgnoringCache).toHaveBeenCalledOnce()
})

it('retries a changed file after its guest was not ready to reload', async () => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview)
  stat.mockResolvedValue({ size: 100, mtime: 2, isDirectory: false })
  reloadIgnoringCache.mockImplementationOnce(() => {
    throw new Error('Guest not ready')
  })

  await refreshLocalHtmlPreview(webview, '/repo/report.html')
  await refreshLocalHtmlPreview(webview, '/repo/report.html')

  expect(reloadIgnoringCache).toHaveBeenCalledTimes(2)
})

it('compares Windows file paths with encoded characters and fragments', async () => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview, 'file:///C:/repo/report%20one.html#section')
  stat.mockResolvedValue({ size: 100, mtime: 2, isDirectory: false })

  await refreshLocalHtmlPreview(webview, 'C:\\repo\\report one.html')

  expect(reloadIgnoringCache).toHaveBeenCalledOnce()
})

it('does not stat ordinary web pages or reload a guest without a loaded-file revision', async () => {
  const { webview, reloadIgnoringCache } = guest()
  navigate(webview, 'https://example.com/report.html')

  await refreshLocalHtmlPreview(webview, '/repo/report.html')

  expect(stat).not.toHaveBeenCalled()
  expect(reloadIgnoringCache).not.toHaveBeenCalled()
})
