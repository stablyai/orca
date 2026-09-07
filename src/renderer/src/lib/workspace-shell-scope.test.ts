// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

afterEach(() => vi.unstubAllGlobals())

it('never gives an inactive remote pane the focused local pane shell scope, including either copy endpoint', async () => {
  const openFilePath = vi.fn().mockResolvedValue(false)
  const copyFile = vi.fn()
  const native = {
    localRuntimeId: 'local-runtime',
    runtimeEnvironments: { resolve: vi.fn().mockResolvedValue({ runtimeId: 'remote-runtime' }) }
  }
  vi.stubGlobal('window', {
    api: { shell: { openFilePath, copyFile }, runtimeEnvironments: native.runtimeEnvironments },
    orcaWorkspaceWindowNative: native
  })
  useAppStore.setState({ activeWorktreeId: 'local', activeWorkspaceExecutionHostId: 'local' })
  const { getWorkspaceShellApi } = await import('./workspace-shell-scope')
  const shell = getWorkspaceShellApi({
    worktreeId: 'remote',
    executionHostId: 'runtime:remote-env',
    runtimeEnvironmentId: 'remote-env',
    connectionId: null
  })
  await shell.openFilePath('/remote/readme.pdf')
  expect(openFilePath).toHaveBeenCalledWith('/remote/readme.pdf', {
    kind: 'workspace',
    runtimeId: 'remote-runtime',
    connectionId: null
  })
  await expect(shell.copyFile({ srcPath: '/remote/a', destPath: '/local/b' })).rejects.toThrow(
    'remote-runtime-unsupported'
  )
  expect(copyFile).not.toHaveBeenCalled()
})
