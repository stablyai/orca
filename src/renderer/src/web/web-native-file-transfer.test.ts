import { afterEach, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

afterEach(() => vi.unstubAllGlobals())
it('uses native staging and download delivery for desktop workspace windows', async () => {
  const globals = installBrowserGlobals()
  const { createFileApi } = await import('./preload-api/web-filesystem-api')
  const stageExternalPathsForRuntimeUpload = vi.fn(async () => ({
    sources: [{ sourcePath: 'C:/picked.png' }]
  }))
  const saveDownloadedFile = vi.fn(async () => ({
    canceled: false,
    destinationPath: 'C:/download.txt'
  }))
  Object.assign(globals.window, {
    orcaWorkspaceWindowNative: {
      fileTransfer: { stageExternalPathsForRuntimeUpload, saveDownloadedFile }
    }
  })
  const api = createFileApi()
  await api.stageExternalPathsForRuntimeUpload({ sourcePaths: ['C:/picked.png'] })
  await api.saveDownloadedFile({
    suggestedName: 'download.txt',
    content: 'download',
    encoding: 'utf8'
  })
  expect(stageExternalPathsForRuntimeUpload).toHaveBeenCalled()
  expect(saveDownloadedFile).toHaveBeenCalled()
})
