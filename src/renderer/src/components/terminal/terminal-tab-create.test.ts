import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createBrowserUuidMock,
  createWebRuntimeSessionTerminalMock,
  getStateMock,
  isWebRuntimeSessionActiveMock
} = vi.hoisted(() => ({
  createBrowserUuidMock: vi.fn(() => 'tab-1'),
  createWebRuntimeSessionTerminalMock: vi.fn(),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))
vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: createBrowserUuidMock
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))

import { createNewTerminalTab } from './terminal-tab-create'
import { terminalOwnerRows } from './terminal-tab-owner-rows.test-fixture'

describe('createNewTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createWebRuntimeSessionTerminalMock.mockResolvedValue(true)
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('delegates terminal creation to the explicit owner runtime when another runtime is focused', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [{ id: 'repo-1', executionHostId: 'runtime:owner-runtime', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      createTab,
      setActiveTabType
    })

    createNewTerminalTab('wt-1', 'pwsh')

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith(
      {
        worktreeId: 'wt-1',
        environmentId: 'owner-runtime',
        shell: 'pwsh',
        activate: true
      },
      { userAct: true }
    )
    expect(createTab).not.toHaveBeenCalled()
  })

  it('reports a failed host launch to the caller instead of toasting it', async () => {
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    createWebRuntimeSessionTerminalMock.mockResolvedValue({ status: 'failed', message: 'offline' })
    getStateMock.mockReturnValue(terminalOwnerRows('web-runtime'))
    const onSettled = vi.fn()

    createNewTerminalTab('wt-1', undefined, { command: 'git fetch --unshallow origin', onSettled })

    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(false))
    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git fetch --unshallow origin' }),
      { userAct: true, notifyFailure: false }
    )
  })
})
