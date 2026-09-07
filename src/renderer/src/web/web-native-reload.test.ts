// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createWebAppApi } from './preload-api/web-app-api'
import { prepareRendererForAppRestart } from '../../../shared/renderer-restart-preparation'

vi.mock('../../../shared/renderer-restart-preparation', () => ({
  prepareRendererForAppRestart: vi.fn()
}))
vi.mock('./preload-api/web-preferences-store', () => ({ readLocalWebUIState: () => ({}) }))
vi.mock('./preload-api/web-runtime-session', () => ({ requireActiveEnvironmentOrNull: () => null }))
afterEach(() => {
  delete window.orcaWorkspaceWindowNative
  vi.restoreAllMocks()
})

it('waits for native disk durability and refuses reload if that flush rejects', async () => {
  let rejectFlush!: (error: Error) => void
  const flush = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectFlush = reject
      })
  )
  Object.assign(window, { orcaWorkspaceWindowNative: { presentationStorage: { flush } } })
  vi.mocked(prepareRendererForAppRestart).mockImplementation(async (_window, options) =>
    options.awaitCheckpoint()
  )
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  const pending = createWebAppApi().app!.reload()
  await Promise.resolve()
  expect(flush).toHaveBeenCalledOnce()
  expect(reload).not.toHaveBeenCalled()
  rejectFlush(new Error('native disk full'))
  await expect(pending).rejects.toThrow('native disk full')
  expect(reload).not.toHaveBeenCalled()
})

it('checkpoints native drafts before reloading and refuses a failed checkpoint', async () => {
  Object.assign(window, { orcaWorkspaceWindowNative: {} })
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  vi.mocked(prepareRendererForAppRestart).mockRejectedValueOnce(new Error('draft write failed'))
  const api = createWebAppApi().app!
  await expect(api.reload()).rejects.toThrow('draft write failed')
  expect(reload).not.toHaveBeenCalled()
  vi.mocked(prepareRendererForAppRestart).mockResolvedValueOnce()
  await api.reload()
  expect(prepareRendererForAppRestart).toHaveBeenCalledWith(
    window,
    expect.objectContaining({ startedEventName: 'orca:app-restart-started' })
  )
  expect(reload).toHaveBeenCalledOnce()
})
