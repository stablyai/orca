import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createResult, connectWslHost, reloadProjects, wslHostStatuses } = vi.hoisted(() => {
  const wslHostStatuses: Record<string, { state: string; distro: string }> = {}
  return {
    createResult: vi.fn(),
    connectWslHost: vi.fn(),
    reloadProjects: vi.fn(),
    wslHostStatuses
  }
})

vi.mock('./web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: createResult
}))
vi.mock('./web-runtime-terminal-create-failure-notice', () => ({
  notifyWebRuntimeTerminalCreateFailure: vi.fn()
}))
vi.mock('../lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: reloadProjects
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ wslHostStatuses }) }
}))

import { createWebRuntimeSessionTerminal } from './web-runtime-terminal-creation'

const ARGS = { worktreeId: 'wt-1', environmentId: 'env-1', activate: true }

beforeEach(() => {
  createResult.mockReset().mockResolvedValue({ outcome: { status: 'created' } })
  connectWslHost.mockReset().mockResolvedValue(undefined)
  reloadProjects.mockReset().mockResolvedValue(true)
  for (const key of Object.keys(wslHostStatuses)) {
    delete wslHostStatuses[key]
  }
  wslHostStatuses['env-1'] = { state: 'distro-stopped', distro: 'Ubuntu' }
  Object.assign(globalThis, {
    window: { api: { runtimeEnvironments: { wslHosts: { connect: connectWslHost } } } }
  })
})

describe('New Terminal on a stopped WSL host', () => {
  it('starts the distro first, as the user asked, then creates the terminal', async () => {
    await expect(createWebRuntimeSessionTerminal(ARGS, { userAct: true })).resolves.toEqual({
      status: 'created'
    })
    expect(connectWslHost).toHaveBeenCalledWith({
      environmentId: 'env-1',
      withdrawPendingRemoval: false
    })
    expect(connectWslHost.mock.invocationCallOrder[0]).toBeLessThan(
      createResult.mock.invocationCallOrder[0]
    )
  })

  it('never boots the distro for a terminal nobody asked for', async () => {
    await createWebRuntimeSessionTerminal(ARGS)
    expect(connectWslHost).not.toHaveBeenCalled()
    expect(createResult).toHaveBeenCalledOnce()
  })

  it('does not touch a host that is running, or any other kind of host', async () => {
    wslHostStatuses['env-1'] = { state: 'ready', distro: 'Ubuntu' }
    await createWebRuntimeSessionTerminal(ARGS, { userAct: true })
    await createWebRuntimeSessionTerminal({ ...ARGS, environmentId: 'ssh-1' }, { userAct: true })
    expect(connectWslHost).not.toHaveBeenCalled()
    expect(createResult).toHaveBeenCalledTimes(2)
  })

  it('creates nothing when the start is refused, such as a pending Remove', async () => {
    connectWslHost.mockRejectedValueOnce(new Error('Ubuntu is being removed.'))
    await expect(createWebRuntimeSessionTerminal(ARGS, { userAct: true })).resolves.toEqual({
      status: 'failed',
      message: 'Ubuntu is stopped'
    })
    expect(createResult).not.toHaveBeenCalled()
  })
})
