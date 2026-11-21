import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../../../shared/settings/global-settings-test-fixture'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { readHostAgentStartupSettings } from '@/runtime/agent-launch-settings/agent-launch-settings-transport'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  buildAiVaultCliForkStartupForWorktree,
  captureAiVaultCliForkOwner,
  readAiVaultCliForkLaunchSettings
} from './ai-vault-session-fork-startup'

vi.mock('@/runtime/agent-launch-settings/agent-launch-settings-transport', () => ({
  readHostAgentStartupSettings: vi.fn()
}))

vi.mock('./ai-vault-resume-command', () => ({
  resolveAiVaultResumeHost: () => ({ platform: 'linux', liveShell: 'posix', codexHome: null })
}))

const readSettings = vi.mocked(readHostAgentStartupSettings)
const remoteHost = toRuntimeExecutionHostId('server')

function forkArgs(executionHostId: ExecutionHostId) {
  const settings = createGlobalSettingsFixture({
    agentCmdOverrides: { claude: 'FOO=BAR claude' },
    agentPermissionDefault: 'own'
  })
  return {
    state: {
      settings,
      activeRepoId: null,
      activeWorktreeId: null,
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      projects: [],
      repos: [],
      runtimeStatusByEnvironmentId: new Map(),
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map(),
      worktreesByRepo: {}
    },
    session: {
      agent: 'claude' as const,
      sessionId: 'source-id',
      cwd: '/repo',
      codexHome: null,
      executionHostId
    },
    copied: false,
    owner: captureAiVaultCliForkOwner(executionHostId)
  }
}

type ForkArgs = Omit<Parameters<typeof buildAiVaultCliForkStartupForWorktree>[0], 'settings'>

function readLaunchSettings(args: ForkArgs) {
  return readAiVaultCliForkLaunchSettings({
    owner: args.owner,
    localSettings: args.state.settings
  })
}

async function buildWithHostSettings(args: ForkArgs) {
  return buildAiVaultCliForkStartupForWorktree({
    ...args,
    settings: await readLaunchSettings(args)
  })
}

afterEach(() => {
  readSettings.mockReset()
  replaceRuntimeEnvironmentRevisions([])
})

describe('terminal fork startup', () => {
  it('builds the Claude fork with the command configured on the session host', async () => {
    readSettings.mockResolvedValue({
      agentCmdOverrides: { claude: 'claude' },
      agentPermissionDefault: 'own'
    })

    await expect(buildWithHostSettings(forkArgs(remoteHost))).resolves.toMatchObject({
      command: "claude '--resume' 'source-id' '--fork-session'"
    })
    await expect(buildWithHostSettings(forkArgs('local'))).resolves.toMatchObject({
      command: "FOO=BAR claude '--resume' 'source-id' '--fork-session'"
    })
    expect(readSettings).toHaveBeenCalledTimes(1)
  })

  it('uses the paired host profile to resume the independent copy', async () => {
    readSettings.mockResolvedValue({
      agentCmdOverrides: { opencode: '/opt/bin/opencode' },
      agentDefaultEnv: { opencode: { SERVER_SETTING: 'enabled' } }
    })
    const args = forkArgs(remoteHost)

    await expect(
      buildWithHostSettings({
        ...args,
        session: { ...args.session, agent: 'opencode', sessionId: 'copy-id' },
        copied: true
      })
    ).resolves.toMatchObject({
      agent: 'opencode',
      command: "/opt/bin/opencode '--session' 'copy-id'",
      env: { SERVER_SETTING: 'enabled' },
      providerSession: { key: 'session_id', id: 'copy-id' }
    })
  })

  it('refuses a paired launch if host settings are unavailable', async () => {
    readSettings.mockResolvedValue(null)
    await expect(buildWithHostSettings(forkArgs(remoteHost))).rejects.toThrow(
      'The conversation host is unavailable.'
    )
  })

  it('refuses settings received after the server was re-paired', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'server', createdAt: 1 }])
    const args = forkArgs(remoteHost)
    readSettings.mockImplementation(async () => {
      replaceRuntimeEnvironmentRevisions([{ id: 'server', createdAt: 2 }])
      return { agentCmdOverrides: { claude: 'claude' }, agentPermissionDefault: 'own' }
    })

    await expect(buildWithHostSettings(args)).rejects.toThrow(
      'The conversation host is unavailable.'
    )
  })

  it('refuses settings read before the server was re-paired during preparation', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'server', createdAt: 1 }])
    const args = forkArgs(remoteHost)
    readSettings.mockResolvedValue({ agentCmdOverrides: { claude: 'claude' } })
    const settings = await readLaunchSettings(args)
    replaceRuntimeEnvironmentRevisions([{ id: 'server', createdAt: 2 }])

    expect(() => buildAiVaultCliForkStartupForWorktree({ ...args, settings })).toThrow(
      'The conversation host is unavailable.'
    )
  })
})
