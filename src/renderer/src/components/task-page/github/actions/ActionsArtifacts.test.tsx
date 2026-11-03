// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ActionsArtifacts } from './ActionsArtifacts'
import * as requests from '@/store/github/actions-artifact-requests'
import { TEST_REPO } from '@/store/slices/store-test-helpers'
import type { ActionsArtifact } from '../../../../../../shared/github/actions-artifact-types'
import type { PreloadApi } from '../../../../../../preload/api-types'
import { ACTIONS_ARTIFACT_MAX_BYTES } from '../../../../../../shared/github/actions-artifact-types'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const option = { repo: TEST_REPO, repository }
const artifact: ActionsArtifact = {
  id: 7,
  name: 'test-report',
  sizeBytes: 4,
  expired: false,
  createdAt: null,
  expiresAt: null
}
const page = {
  repository,
  items: [artifact],
  page: 1,
  perPage: 100,
  totalCount: 1,
  hasNextPage: false,
  limitReached: false
}
const start = vi.fn<PreloadApi['fs']['startDownloadedFile']>()
const append = vi.fn<PreloadApi['fs']['appendDownloadedFileChunk']>()
const finish = vi.fn<PreloadApi['fs']['finishDownloadedFile']>()
const cancel = vi.fn<PreloadApi['fs']['cancelDownloadedFile']>()
beforeEach(() => {
  vi.spyOn(requests, 'fetchActionsArtifacts').mockResolvedValue(page)
  vi.spyOn(requests, 'startActionsArtifactDownload').mockResolvedValue({
    transferId: 'remote',
    sizeBytes: 4,
    fileName: 'test-report.zip'
  })
  vi.spyOn(requests, 'readActionsArtifactChunk').mockResolvedValue({
    contentBase64: 'UEsFBg==',
    nextOffset: 4,
    done: true
  })
  vi.spyOn(requests, 'releaseActionsArtifactDownload').mockResolvedValue(undefined)
  start.mockReset().mockResolvedValue({
    canceled: false,
    transferId: 'local',
    destinationPath: '/tmp/test-report.zip'
  })
  append.mockReset().mockResolvedValue({ ok: true })
  finish.mockReset().mockResolvedValue({ canceled: false, destinationPath: '/tmp/test-report.zip' })
  cancel.mockReset().mockResolvedValue({ ok: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      fs: {
        startDownloadedFile: start,
        appendDownloadedFileChunk: append,
        finishDownloadedFile: finish,
        cancelDownloadedFile: cancel
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const mount = () => render(<ActionsArtifacts option={option} runId={900} />)
const ready = () => screen.findByRole('button', { name: 'Download test-report' })
it('renders the artifact list and refreshes it', async () => {
  mount()
  await ready()
  expect(screen.getByText('test-report')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh artifacts' }))
  await waitFor(() => expect(requests.fetchActionsArtifacts).toHaveBeenCalledTimes(2))
})
it('renders the empty state', async () => {
  vi.mocked(requests.fetchActionsArtifacts).mockResolvedValue({ ...page, items: [], totalCount: 0 })
  mount()
  expect(await screen.findByText('No artifacts are available for this run.')).toBeTruthy()
})
it('disables downloads for expired artifacts', async () => {
  vi.mocked(requests.fetchActionsArtifacts).mockResolvedValue({
    ...page,
    items: [{ ...artifact, expired: true }]
  })
  mount()
  expect((await ready()).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('Expired')).toBeTruthy()
})
it('shows size and expiry and prevents archives over the download limit', async () => {
  vi.mocked(requests.fetchActionsArtifacts).mockResolvedValue({
    ...page,
    items: [
      { ...artifact, sizeBytes: ACTIONS_ARTIFACT_MAX_BYTES + 1, expiresAt: '2030-01-01T00:00:00Z' }
    ]
  })
  mount()
  expect((await ready()).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(/64\.0 MB.*Expires/)).toBeTruthy()
  expect(screen.getByText('Over 64 MiB. Use Open run on GitHub to download.')).toBeTruthy()
  expect(requests.startActionsArtifactDownload).not.toHaveBeenCalled()
})
it('renders a list failure and retries successfully', async () => {
  vi.mocked(requests.fetchActionsArtifacts).mockRejectedValueOnce(new Error('List unavailable'))
  mount()
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('List unavailable')
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await ready()
})
it('cancels the save dialog without requesting archive bytes', async () => {
  start.mockResolvedValue({ canceled: true })
  mount()
  fireEvent.click(await ready())
  await act(async () => {
    await Promise.resolve()
  })
  expect(requests.startActionsArtifactDownload).not.toHaveBeenCalled()
  expect(append).not.toHaveBeenCalled()
  expect(screen.queryByText(/Saved ZIP/)).toBeNull()
})
it('saves mock ZIP bytes and reports the destination', async () => {
  mount()
  fireEvent.click(await ready())
  expect(await screen.findByText('Saved ZIP to /tmp/test-report.zip')).toBeTruthy()
  expect(append).toHaveBeenCalledWith({ transferId: 'local', contentBase64: 'UEsFBg==' })
  expect(finish).toHaveBeenCalledWith({ transferId: 'local' })
  expect(requests.releaseActionsArtifactDownload).toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
})
it('reports download failure and cleans up the local transfer', async () => {
  vi.mocked(requests.startActionsArtifactDownload).mockRejectedValue(
    new Error('Download unavailable')
  )
  mount()
  fireEvent.click(await ready())
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Download unavailable')
  expect(cancel).toHaveBeenCalledWith({ transferId: 'local' })
})

it('cancels an active transfer and removes partial local bytes', async () => {
  let resolveTransfer:
    | ((value: { transferId: string; sizeBytes: number; fileName: string }) => void)
    | undefined
  vi.mocked(requests.startActionsArtifactDownload).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveTransfer = resolve
      })
  )
  mount()
  fireEvent.click(await ready())
  await waitFor(() => expect(resolveTransfer).toBeDefined())
  fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }))
  await act(async () => {
    resolveTransfer?.({ transferId: 'remote', sizeBytes: 4, fileName: 'test-report.zip' })
  })
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Download test-report' }).hasAttribute('disabled')
    ).toBe(false)
  )
  expect(screen.queryByRole('alert')).toBeNull()
  expect(requests.readActionsArtifactChunk).not.toHaveBeenCalled()
  expect(requests.releaseActionsArtifactDownload).toHaveBeenCalled()
  expect(cancel).toHaveBeenCalledWith({ transferId: 'local' })
  expect(finish).not.toHaveBeenCalled()
})

it('localizes invalid chunks and cleans up both transfers', async () => {
  vi.mocked(requests.readActionsArtifactChunk).mockResolvedValue({
    contentBase64: 'UEsFBg==',
    nextOffset: 0,
    done: false
  })
  mount()
  fireEvent.click(await ready())
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Invalid artifact download chunk'
  )
  expect(cancel).toHaveBeenCalledWith({ transferId: 'local' })
  expect(requests.releaseActionsArtifactDownload).toHaveBeenCalled()
  expect(finish).not.toHaveBeenCalled()
})

it('disables unsupported paired-web downloads and explains the available path', async () => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  try {
    mount()
    const button = await ready()
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByText(
        'Download ZIP is available in the desktop app. Use Open run on GitHub to download.'
      )
    ).toBeTruthy()
    fireEvent.click(button)
    expect(start).not.toHaveBeenCalled()
    expect(requests.startActionsArtifactDownload).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('makes final saving non-cancelable and reports the actual committed result', async () => {
  const held = Promise.withResolvers<Awaited<ReturnType<typeof finish>>>()
  finish.mockReturnValueOnce(held.promise)
  mount()
  fireEvent.click(await ready())
  await waitFor(() => expect(finish).toHaveBeenCalledOnce())
  const cancelButton = screen.getByRole('button', { name: 'Cancel download' })
  expect(cancelButton.hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('status').textContent).toBe('Saving ZIP…')
  fireEvent.click(cancelButton)
  fireEvent.click(cancelButton)
  await act(async () => held.resolve({ canceled: false, destinationPath: '/tmp/test-report.zip' }))
  expect(await screen.findByText('Saved ZIP to /tmp/test-report.zip')).toBeTruthy()
  expect(cancel).not.toHaveBeenCalled()
  expect(requests.releaseActionsArtifactDownload).toHaveBeenCalledOnce()
})

it('admits only one save when download is clicked repeatedly before React renders', async () => {
  const held = Promise.withResolvers<Awaited<ReturnType<typeof start>>>()
  start.mockReturnValueOnce(held.promise)
  mount()
  const button = await ready()
  act(() => {
    button.click()
    button.click()
  })
  expect(start).toHaveBeenCalledOnce()
  await act(async () => held.resolve({ canceled: true }))
  expect(requests.startActionsArtifactDownload).not.toHaveBeenCalled()
})

it('keeps an old finalization from overwriting a new run’s pending save', async () => {
  const first = Promise.withResolvers<Awaited<ReturnType<typeof finish>>>()
  const second = Promise.withResolvers<Awaited<ReturnType<typeof finish>>>()
  finish.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  start
    .mockResolvedValueOnce({
      canceled: false,
      transferId: 'first',
      destinationPath: '/tmp/first.zip'
    })
    .mockResolvedValueOnce({
      canceled: false,
      transferId: 'second',
      destinationPath: '/tmp/second.zip'
    })
  const view = mount()
  fireEvent.click(await ready())
  await waitFor(() => expect(finish).toHaveBeenCalledTimes(1))
  view.rerender(<ActionsArtifacts option={option} runId={901} />)
  fireEvent.click(await ready())
  await waitFor(() => expect(finish).toHaveBeenCalledTimes(2))
  await act(async () => first.resolve({ canceled: false, destinationPath: '/tmp/first.zip' }))
  expect(screen.queryByText('Saved ZIP to /tmp/first.zip')).toBeNull()
  expect((await ready()).hasAttribute('disabled')).toBe(true)
  await act(async () => second.resolve({ canceled: false, destinationPath: '/tmp/second.zip' }))
  expect(await screen.findByText('Saved ZIP to /tmp/second.zip')).toBeTruthy()
  expect(cancel).not.toHaveBeenCalled()
})

it('releases both transfers after navigating away during acquisition', async () => {
  const held =
    Promise.withResolvers<Awaited<ReturnType<typeof requests.startActionsArtifactDownload>>>()
  vi.mocked(requests.startActionsArtifactDownload).mockReturnValueOnce(held.promise)
  const view = mount()
  fireEvent.click(await ready())
  await waitFor(() => expect(requests.startActionsArtifactDownload).toHaveBeenCalledOnce())
  view.unmount()
  await act(async () =>
    held.resolve({ transferId: 'remote', sizeBytes: 4, fileName: 'test-report.zip' })
  )
  expect(requests.releaseActionsArtifactDownload).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledWith({ transferId: 'local' })
  expect(finish).not.toHaveBeenCalled()
})

it('keeps the same save when the parent recreates equivalent repository options', async () => {
  const held = Promise.withResolvers<Awaited<ReturnType<typeof finish>>>()
  finish.mockReturnValueOnce(held.promise)
  const view = mount()
  fireEvent.click(await ready())
  await waitFor(() => expect(finish).toHaveBeenCalledOnce())
  view.rerender(
    <ActionsArtifacts
      option={{ repo: { ...TEST_REPO }, repository: { ...repository } }}
      runId={900}
    />
  )
  expect(screen.getByRole('button', { name: 'Cancel download' }).hasAttribute('disabled')).toBe(
    true
  )
  await act(async () => held.resolve({ canceled: false, destinationPath: '/tmp/test-report.zip' }))
  expect(await screen.findByText('Saved ZIP to /tmp/test-report.zip')).toBeTruthy()
})
