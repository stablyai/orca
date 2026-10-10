// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { launchWorkspaceState, perClientLoader } from '@/lib/launch-parity-renderer.test-fixture'
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../../../shared/launch-parity-window-cases.test-fixture'
import type {
  LaunchClient,
  LaunchWorkspace
} from '../../../../shared/launch-parity-window-request.test-fixture'
import type { TuiAgent } from '../../../../shared/tui-agent'

// The selection hook's async probes; the platform and shell it derives are synchronous.
vi.mock('@/hooks/useDetectedAgents', () => ({ useDetectedAgents: () => ({ detectedIds: null }) }))
vi.mock('@/components/sidebar/folder-workspace-composer-path-status', () => ({
  useFolderWorkspaceComposerPathStatus: () => ({
    pathStatusBlocksCreate: false,
    pathStatusProjectError: null
  })
}))
vi.mock('@/hooks/useEphemeralVmRecipeOptions', () => ({
  useEphemeralVmRecipeOptions: () => ({
    recipes: [],
    selectedRecipeId: null,
    setSelectedRecipeId: vi.fn(),
    error: null
  })
}))

const load = perClientLoader(async () => ({
  quick: await import('./quick-startup-plan'),
  selection: await import('./runtime-target-selection'),
  composerRepo: await import('@/lib/new-workspace-composer-repo'),
  // Same module graph as the hook, so both see one React.
  react: await import('@testing-library/react')
}))

type QuickCase = {
  name: string
  client: LaunchClient
  workspace: LaunchWorkspace
  settings?: Record<string, unknown>
  agent: TuiAgent | null
  prompt?: string
  draftPrompt?: string
  telemetrySource?: 'onboarding'
  /** The composer's quoting platform and shell, then the startup creation gets (null: none). */
  plan: [NodeJS.Platform, string | undefined]
  startup: { command: string; agentCommand: string } | null
}

/** runtime-target-selection.ts's host fact and shell, handed to the startup builder as quick-creation-execution.ts does. */
async function quickStartup(c: QuickCase) {
  const { quick, selection, composerRepo, react, createStore } = await load(c.client)
  const store = createStore()
  store.setState(
    launchWorkspaceState(c.workspace, {
      agentDefaultArgs: { claude: '--model sonnet' },
      agentDefaultEnv: { claude: { CLAUDE_FLAG: '1' } },
      ...c.settings
    })
  )
  const state = store.getState()
  // Fed the store as composer-target-store.ts reads it; with no host setups the draft repo is selected.
  const { result } = react.renderHook(() =>
    selection.useComposerRuntimeTargetSelection({
      actionableHostIds: new Set(),
      activeRepoId: null,
      eligibleRepos: composerRepo.getComposerEligibleRepos(state.repos),
      hostOptions: [],
      initialEphemeralVmRecipeId: undefined,
      projectGroups: state.projectGroups,
      projectHostSetups: [],
      projects: state.projects,
      repoId: state.repos[0].id,
      repos: state.repos,
      selectedProjectGroup: null,
      selectedProjectHostSetupOverrideId: null,
      settings: state.settings,
      sshConnectionStates: state.sshConnectionStates,
      workspaceHostScope: state.workspaceHostScope,
      worktreesByRepo: state.worktreesByRepo
    })
  )
  const { selectedRepoAgentLaunchFact, selectedRepoStartupShell, selectedRepoIsRemote } =
    result.current
  const built = quick.buildQuickComposerStartup({
    agent: c.agent,
    prompt: c.prompt ?? '',
    draftPrompt: c.draftPrompt,
    settings: state.settings,
    launchHost: selectedRepoAgentLaunchFact,
    shell: selectedRepoStartupShell,
    isRemote: selectedRepoIsRemote,
    telemetrySource: c.telemetrySource
  })
  return {
    launchPlatform:
      selectedRepoAgentLaunchFact.kind === 'known'
        ? selectedRepoAgentLaunchFact.platform
        : selectedRepoAgentLaunchFact.reason,
    startupShell: selectedRepoStartupShell,
    result: built
  }
}

const repo = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'repo',
  path,
  ...extra
})
const BOB = "fix Bob's bug"
const MODEL = "claude '--model' 'sonnet'"
const CODEX = "codex '--dangerously-bypass-approvals-and-sandbox'"
// A linked item's draft rides --prefill; the apostrophe shows the quoting.
const posix = { command: `${MODEL} --prefill 'fix Bob'"'"'s bug'`, agentCommand: MODEL }
const powershell = { command: `${MODEL} --prefill 'fix Bob''s bug'`, agentCommand: MODEL }
const WSL = { kind: 'wsl', distro: 'Ubuntu' } as const
const SSH = { connectionId: 'ssh-1' }
const CMD = { terminalWindowsShell: 'cmd.exe' }
const quickCase = (
  name: string,
  client: LaunchClient,
  workspace: LaunchWorkspace,
  input: Pick<QuickCase, 'agent' | 'prompt' | 'draftPrompt' | 'telemetrySource' | 'settings'>,
  plan: QuickCase['plan'],
  startup: QuickCase['startup']
): QuickCase => ({ name, client, workspace, ...input, plan, startup })
// The composer's text becomes the worktree note; the agent gets a linked item's draft, or nothing.
const claude = { agent: 'claude', draftPrompt: BOB } as const

const CASES: QuickCase[] = [
  quickCase('macOS repo', 'darwin', repo(POSIX_PATH), claude, ['darwin', undefined], posix),
  // main today: with no prompt on the command, codex does not wait for the shell.
  quickCase(
    'macOS repo, codex',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'codex' },
    ['darwin', undefined],
    { command: CODEX, agentCommand: CODEX }
  ),
  quickCase(
    'Windows C: repo, default PowerShell',
    'win32',
    repo(WIN_PATH),
    claude,
    ['win32', 'powershell'],
    powershell
  ),
  quickCase(
    'Windows C: repo, cmd.exe',
    'win32',
    repo(WIN_PATH),
    { ...claude, settings: CMD },
    ['win32', 'cmd'],
    {
      command: `claude "--model" "sonnet" --prefill "fix Bob's bug"`,
      agentCommand: 'claude "--model" "sonnet"'
    }
  ),
  quickCase(
    'Windows C: repo, project WSL',
    'win32',
    repo(WIN_PATH, { projectRuntime: WSL }),
    claude,
    ['linux', undefined],
    posix
  ),
  quickCase(
    'Windows wsl$ repo, no saved runtime',
    'win32',
    repo(WSL_PATH),
    claude,
    ['linux', undefined],
    posix
  ),
  // The local shell setting never reaches an SSH target; the OS its relay reports decides the quoting.
  quickCase(
    'Windows client, SSH repo, cmd.exe',
    'win32',
    repo(POSIX_PATH, SSH),
    { ...claude, settings: CMD },
    ['linux', undefined],
    posix
  ),
  quickCase(
    'macOS client, SSH Windows-path repo',
    'darwin',
    repo(WIN_PATH, SSH),
    claude,
    ['win32', undefined],
    powershell
  ),
  quickCase(
    'macOS repo, no linked item',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'claude' },
    ['darwin', undefined],
    { command: MODEL, agentCommand: MODEL }
  ),
  // Only a linked Linear item with no URL and no issue block becomes a typed prompt.
  quickCase(
    'macOS repo, Linear typed-only item',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'claude', prompt: 'hi' },
    ['darwin', undefined],
    { command: `${MODEL} 'hi'`, agentCommand: MODEL }
  ),
  quickCase(
    'macOS repo, onboarding',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'claude', telemetrySource: 'onboarding' },
    ['darwin', undefined],
    { command: MODEL, agentCommand: MODEL }
  ),
  // A draft without a native prefill stays with the window.
  quickCase(
    'macOS repo, codex draft',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'codex', draftPrompt: 'draft me' },
    ['darwin', undefined],
    null
  )
]

// Pins main's current launch behaviour as the convergence parity baseline (row 8, quick
// composer): the platform and shell the composer picks, and the startup it hands creation.
describe('row 8: quick composer startup on main', () => {
  beforeAll(async () => {
    await load('darwin')
    await load('win32')
  }, 240_000)
  afterEach(() => vi.unstubAllGlobals())

  it.each(CASES)('$name', async (c) => {
    const { launchPlatform, startupShell, result } = await quickStartup(c)

    expect([launchPlatform, startupShell]).toEqual(c.plan)
    expect(result.startupPlan).not.toBeNull()
    const claudeEnv = c.agent === 'claude' ? { CLAUDE_FLAG: '1' } : {}
    expect(result.backendStartup).toEqual(
      c.startup === null
        ? undefined
        : {
            command: c.startup.command,
            env: claudeEnv,
            launchAgent: c.agent,
            launchConfig: {
              agentCommand: c.startup.agentCommand,
              agentArgs:
                c.agent === 'claude'
                  ? '--model sonnet'
                  : '--dangerously-bypass-approvals-and-sandbox',
              agentEnv: claudeEnv
            },
            telemetry: {
              agent_kind: c.agent === 'claude' ? 'claude-code' : c.agent,
              launch_source: c.telemetrySource ?? 'new_workspace_composer',
              request_kind: 'new'
            }
          }
    )
  })

  it('no agent builds nothing', async () => {
    const { result } = await quickStartup({
      ...CASES[0],
      agent: null,
      prompt: 'ignored'
    })
    expect(result).toEqual({ startupPlan: null, backendStartup: undefined, telemetry: null })
  })
})
