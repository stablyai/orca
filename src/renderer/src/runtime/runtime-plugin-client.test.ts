import { describe, expect, it, vi } from 'vitest'
import {
  pluginRuntimeOwner,
  listRuntimePlugins,
  readRuntimePluginPanel,
  runtimePluginPanelAction,
  invokeRuntimePluginCommand
} from './runtime-plugin-client'
import { callRuntimeRpc } from './runtime-rpc-client'
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

describe('plugin runtime ownership', () => {
  it('uses the selected workspace host instead of the default server', () => {
    expect(
      pluginRuntimeOwner({
        activeWorktreeId: 'r::/repo',
        activeWorkspaceExecutionHostId: 'runtime:server-a',
        settings: { activeRuntimeEnvironmentId: 'server-b' }
      })
    ).toBe('server-a')
    expect(
      pluginRuntimeOwner({
        activeWorktreeId: 'r::/repo',
        activeWorkspaceExecutionHostId: 'local',
        settings: { activeRuntimeEnvironmentId: 'server-b' }
      })
    ).toBeNull()
  })
  it('resolves folder workspaces and keeps direct SSH plugins on the desktop', () => {
    expect(
      pluginRuntimeOwner({
        activeWorktreeId: 'folder:f',
        activeWorkspaceExecutionHostId: 'runtime:server-a'
      })
    ).toBe('server-a')
    expect(
      pluginRuntimeOwner({
        activeWorktreeId: 'r::/repo',
        activeWorkspaceExecutionHostId: 'ssh:box'
      })
    ).toBeNull()
  })
  it('does not interpret missing workspace ownership as local', () => {
    expect(
      pluginRuntimeOwner({
        activeWorktreeId: 'r::/repo',
        runtimeEnvironments: [{ id: 'a' }, { id: 'b' }]
      })
    ).toBeUndefined()
  })
  it('uses the selected runtime when no workspace is open', () => {
    expect(pluginRuntimeOwner({ settings: { activeRuntimeEnvironmentId: 'a' } })).toBe('a')
    expect(pluginRuntimeOwner({})).toBeNull()
  })
  it('pins list, panel, session actions and commands to the same server', async () => {
    await listRuntimePlugins('a')
    await readRuntimePluginPanel('a', 'sample.board', 'main')
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ outcome: { ok: true, value: { host: 'a' } } })
    const outcome = await runtimePluginPanelAction('a', {
      sessionToken: 'token',
      action: 'workspace.readContext'
    })
    expect(outcome).toEqual({ ok: true, value: { host: 'a' } })
    await invokeRuntimePluginCommand('a', 'sample.board', 'refresh')
    expect(vi.mocked(callRuntimeRpc).mock.calls).toEqual([
      [{ kind: 'environment', environmentId: 'a' }, 'plugins.list'],
      [
        { kind: 'environment', environmentId: 'a' },
        'plugins.readPanelEntry',
        { pluginKey: 'sample.board', panelId: 'main' }
      ],
      [
        { kind: 'environment', environmentId: 'a' },
        'plugins.panelAction',
        { sessionToken: 'token', action: 'workspace.readContext' }
      ],
      [
        { kind: 'environment', environmentId: 'a' },
        'plugins.invokeCommand',
        { pluginKey: 'sample.board', commandId: 'refresh' }
      ]
    ])
  })
})
