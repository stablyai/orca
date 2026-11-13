// @vitest-environment happy-dom
// #568 FAIL-CLOSED on the GH-CREATE-SHEET path: a GitHub-only Orca Cloud create whose agent isn't set
// up never launches Claude on the paired host, even before the renderer's catalog flags it as Orca
// Cloud. The build sheet hands off to the opened workspace; its first agent launch goes through the
// account hold, which asks main when the flag is absent, and opens only the plain placeholder shell.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { setOrcaCloudAgentAccountsStateForTest } from './orca-cloud-agent-accounts-store'
import {
  cloudTabHoldKey,
  readCloudAgentHold,
  releaseCloudAgentHold
} from './cloud-agent-launch-hold'

const host = vi.hoisted(() => ({
  creates: [] as { launchAgent?: string; environmentId: string | null }[]
}))

vi.mock('@/components/cloud-workspaces/open-cloud-workspace', () => ({
  openCloudWorkspace: async () => ({ ok: true, worktreeId: 'wt-1', hostId: 'runtime:env-paired' }),
  firstWorktreeOnHost: () => 'wt-1'
}))
vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: async () => 'applied'
}))
vi.mock('@/runtime/hosted-terminals/placement/web-session-terminal-placement', () => ({
  webTerminalPlacementParentTabId: (id: string) => id
}))
vi.mock('@/components/agent-tab-launch-context', () => ({
  captureAgentTabLaunchContext: () => ({})
}))
// The new-tab launch on a paired web host is one host terminal create through the account hold.
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', async () => {
  const { createWithCloudAgentHold } = await import('./cloud-web-host-launch-hold')
  return {
    launchAgentInNewTabWithOutcome: (args: { agent: string; worktreeId: string }) => {
      void createWithCloudAgentHold(
        { worktreeId: args.worktreeId, environmentId: 'env-paired', launchAgent: args.agent },
        async (create) => {
          host.creates.push(create)
          return { outcome: { status: 'created' }, hostTabId: `h${host.creates.length}` }
        }
      )
    }
  }
})

const { startCloudWorkspaceFromGitHub } = await import('./start-cloud-workspace-from-github')
const { toWebTerminalSurfaceTabId } =
  await import('../../../../shared/workspace-layout/terminal-surface-id')

beforeEach(() => {
  host.creates = []
  setOrcaCloudAgentAccountsStateForTest({
    load: {
      kind: 'ready',
      status: {
        credentials: {
          claude: { state: 'none' },
          codex: { state: 'none' },
          providerEnabled: { claude: true, codex: true }
        },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  })
  // The fresh pairing is in the catalog without its orcaCloudPaired flag yet; main knows it.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the checks read only id, name and source
  const runtimeEnvironments = [
    { id: 'env-paired', name: 'web (cloud)', source: 'manual' }
  ] as unknown as ReturnType<typeof useAppStore.getState>['runtimeEnvironments']
  useAppStore.setState({ pendingWorktreeCreations: {}, runtimeEnvironments })
  Object.assign(window, {
    api: {
      ...window.api,
      orcaCloudWorkspace: {
        createFromGitHub: async () => ({ ok: true, value: { sandboxId: 'sbx_1' } })
      },
      cloudWorkspaces: { get: async (id: string) => ({ ok: true, value: { id } }) },
      ephemeralVm: { onProvisionEvent: () => () => undefined },
      orcaCloudAgents: {
        isCloudEnvironment: async ({ runtimeEnvironmentId }: { runtimeEnvironmentId: string }) =>
          runtimeEnvironmentId === 'env-paired'
      }
    }
  })
})

describe('GH-CREATE-SHEET create on a paired host, Claude not set up (FAIL-CLOSED, #568)', () => {
  it('never launches Claude: only the placeholder shell opens, held on "Set up once"', async () => {
    await expect(
      startCloudWorkspaceFromGitHub({
        repoUrl: 'https://github.com/acme/web',
        fullName: 'acme/web',
        prompt: '',
        agent: 'claude'
      })
    ).resolves.toBe(true)
    await vi.waitFor(() =>
      expect(readCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')))).toMatchObject({
        reason: 'notSetUp'
      })
    )
    expect(host.creates).toHaveLength(1)
    expect(host.creates[0]).not.toHaveProperty('launchAgent')
    releaseCloudAgentHold(cloudTabHoldKey(toWebTerminalSurfaceTabId('h1')), 'cancel')
  })
})
