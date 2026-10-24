import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import { useAppStore } from '@/store'
import {
  resolveDismissedOnboardingFolderAgentLaunch,
  revealOnboardingFolderWithAgentLaunch
} from '@/lib/onboarding-folder-agent-launch'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
} from '../../../../shared/protocol-version'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'

const worktreeActivation = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('../../lib/worktree-activation', () => ({
  activateAndRevealWorktree: worktreeActivation.activateAndRevealWorktree
}))

vi.mock('@/lib/new-workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLIENT_PLATFORM: 'win32'
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
afterEach(() => vi.restoreAllMocks())

const reposAdd = vi.fn()
const worktreesListDetected = vi.fn()
const onboardingGet = vi.fn()
const onboardingUpdate = vi.fn()

beforeEach(() => {
  reposAdd.mockReset()
  worktreesListDetected.mockReset()
  onboardingGet.mockReset()
  onboardingUpdate.mockReset()
  worktreeActivation.activateAndRevealWorktree.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { add: reposAdd },
      worktrees: { listDetected: worktreesListDetected },
      onboarding: { get: onboardingGet, update: onboardingUpdate }
    }
  })
})

describe('repo slice skipped-onboarding folder startup', () => {
  it('only seeds the onboarding default agent for the first dismissed-onboarding folder', async () => {
    reposAdd
      .mockResolvedValueOnce({
        repo: { id: 'folder-1', path: '/first', displayName: 'First', addedAt: 1 }
      })
      .mockResolvedValueOnce({
        repo: { id: 'folder-2', path: '/second', displayName: 'Second', addedAt: 2 }
      })
    worktreesListDetected.mockImplementation(({ repoId }: { repoId: string }) =>
      makeDetectedResult(repoId, [makeWorktree({ id: `${repoId}::/folder`, repoId })])
    )
    let onboarding: OnboardingState = { ...getDefaultOnboardingState(), outcome: 'dismissed' }
    onboardingGet.mockImplementation(async () => onboarding)
    onboardingUpdate.mockImplementation(
      async ({ checklist }: { checklist: Partial<OnboardingState['checklist']> }) => {
        onboarding = { ...onboarding, checklist: { ...onboarding.checklist, ...checklist } }
        return onboarding
      }
    )
    const store = createTestStore()
    store.setState({
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'codex'
      }
    })

    await store.getState().addNonGitFolder('/first')
    await store.getState().addNonGitFolder('/second')

    expect(worktreeActivation.activateAndRevealWorktree).toHaveBeenNthCalledWith(
      1,
      'folder-1::/folder',
      {
        sidebarRevealBehavior: 'auto',
        startup: {
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          env: {},
          launchAgent: 'codex',
          launchConfig: {
            agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          },
          sessionOptions: undefined,
          telemetry: {
            agent_kind: 'codex',
            launch_source: 'onboarding',
            request_kind: 'new'
          }
        }
      }
    )
    expect(worktreeActivation.activateAndRevealWorktree).toHaveBeenNthCalledWith(
      2,
      'folder-2::/folder',
      { sidebarRevealBehavior: 'auto' }
    )
  })
})

it.each(['paired-linux', 'local-bash', 'withheld', 'structured-withheld'] as const)(
  'reveals onboarding folder using execution facts: %s',
  async (target) => {
    const store = createTestStore()
    const hostId = target === 'local-bash' ? 'local' : 'runtime:box'
    const worktree = makeWorktree({ id: 'repo::/folder', repoId: 'repo', path: '/folder', hostId })
    store.setState({
      repos: [{ id: 'repo', path: '/folder', displayName: 'Folder', badgeColor: '', addedAt: 1 }],
      worktreesByRepo: { repo: [worktree] },
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'claude',
        experimentalNativeChat: true,
        nativeChatProviders: { claude: target === 'structured-withheld' },
        terminalWindowsShell: 'C:\\Program Files\\Git\\bin\\bash.exe',
        agentDefaultArgs: { claude: '--append-system-prompt "don\'t edit"' },
        agentPermissionOverrides: { claude: 'own' }
      },
      runtimeStatusByEnvironmentId: new Map([
        [
          'box',
          {
            checkedAt: 1,
            status: {
              runtimeId: 'box',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              ...(target === 'paired-linux' ? { hostPlatform: 'linux' as const } : {}),
              capabilities: [
                STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
                STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
              ]
            }
          }
        ]
      ])
    })
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const launch = await resolveDismissedOnboardingFolderAgentLaunch({
      store: store.getState(),
      worktreeId: worktree.id,
      executionHostId: hostId,
      onboarding: { ...getDefaultOnboardingState(), outcome: 'dismissed' },
      hasExistingProject: false
    })
    if (target === 'structured-withheld') {
      expect(launch.plan?.route).toBe('structured-native-chat')
      expect(launch.startup).toBeUndefined()
      return
    }
    await revealOnboardingFolderWithAgentLaunch({
      worktreeId: worktree.id,
      executionHostId: undefined,
      launch
    })
    expect(worktreeActivation.activateAndRevealWorktree).toHaveBeenCalledWith(
      worktree.id,
      target === 'withheld'
        ? { sidebarRevealBehavior: 'auto' }
        : expect.objectContaining({
            startup: expect.objectContaining({
              command: `claude '--append-system-prompt' 'don'"'"'t edit'`
            })
          })
    )
  }
)
