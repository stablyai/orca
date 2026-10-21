import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'

const supportsCapability = vi.hoisted(() => vi.fn())
vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: supportsCapability
}))

const { buildPlainCreateTerminalParams, resolveCreateTerminalShellParams } =
  await import('./web-runtime-plain-terminal-create-params')

describe('resolveCreateTerminalShellParams', () => {
  beforeEach(() => {
    supportsCapability.mockReset()
  })

  it('sends the pick as the shell on hosts that advertise shell selection', async () => {
    supportsCapability.mockResolvedValue(true)

    await expect(resolveCreateTerminalShellParams('env-1', { shell: 'git-bash' })).resolves.toEqual(
      { command: undefined, shell: 'git-bash' }
    )
    expect(supportsCapability).toHaveBeenCalledWith(
      'env-1',
      SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY
    )
  })

  it('falls back to the typed command for hosts that would drop the shell', async () => {
    supportsCapability.mockResolvedValue(false)

    await expect(resolveCreateTerminalShellParams('env-1', { shell: 'cmd.exe' })).resolves.toEqual({
      command: 'cmd.exe'
    })
  })

  it('does not probe the host when no shell was picked', async () => {
    await expect(resolveCreateTerminalShellParams('env-1', { command: 'ls' })).resolves.toEqual({
      command: 'ls'
    })
    expect(supportsCapability).not.toHaveBeenCalled()
  })

  it('builds caller-selected plain terminal params with the shell pick', async () => {
    supportsCapability.mockResolvedValue(true)

    const params = await buildPlainCreateTerminalParams('env-1', {
      worktreeId: 'repo-1::/repo',
      shell: 'cmd.exe'
    })

    expect(params).toMatchObject({ shell: 'cmd.exe', select: true, navigation: 'caller' })
    expect(params.command).toBeUndefined()
  })
})
