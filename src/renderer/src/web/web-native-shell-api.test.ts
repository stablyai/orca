import { afterEach, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

afterEach(() => vi.unstubAllGlobals())
it('routes desktop presentation shell actions through the native bridge', async () => {
  const globals = installBrowserGlobals()
  const { createShellApi } = await import('./preload-api/web-shell-api')
  const openInFileManager = vi.fn(async () => ({ ok: true }))
  Object.assign(globals.window, { orcaWorkspaceWindowNative: { shell: { openInFileManager } } })
  await createShellApi().openInFileManager('C:/workspace')
  expect(openInFileManager).toHaveBeenCalledWith('C:/workspace', {
    kind: 'workspace',
    runtimeId: null
  })
})
