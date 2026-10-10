import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { launchWorkspaceState, perClientLoader } from '@/lib/launch-parity-renderer-fixture'
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

const load = perClientLoader(async () => ({
  quick: await import('./quick-startup-plan'),
  platform: await import('@/lib/agent-launch-platform'),
  preflight: await import('@/lib/local-preflight-context'),
  newWorkspace: await import('@/lib/new-workspace'),
  shell: await import('../../../../shared/windows-terminal-shell')
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

/** runtime-target-selection.ts's composer rule, then the startup it hands workspace creation. */
async function quickStartup(c: QuickCase) {
  const { quick, platform, preflight, newWorkspace, shell, createStore } = await load(c.client)
  const store = createStore()
  store.setState(
    launchWorkspaceState(c.workspace, {
      agentDefaultArgs: { claude: '--model sonnet' },
      agentDefaultEnv: { claude: { CLAUDE_FLAG: '1' } },
      ...c.settings
    })
  )
  const state = store.getState()
  const repo = state.repos[0]
  const isRemote = Boolean(repo.connectionId)
  const launchPlatform = platform.getAgentLaunchPlatformForRepo(
    repo,
    isRemote
      ? undefined
      : preflight.getLocalRepoProjectExecutionRuntimeContext(
          { ...state, activeWorktreeId: null },
          repo.id,
          newWorkspace.CLIENT_PLATFORM
        )
  )
  const startupShell = shell.resolveLocalWindowsAgentStartupShell({
    platform: launchPlatform,
    isRemote,
    terminalWindowsShell: state.settings?.terminalWindowsShell
  })
  const result = quick.buildQuickComposerStartup({
    agent: c.agent,
    prompt: c.prompt ?? '',
    draftPrompt: c.draftPrompt,
    settings: state.settings,
    platform: launchPlatform,
    shell: startupShell,
    isRemote,
    telemetrySource: c.telemetrySource
  })
  return { launchPlatform, startupShell, result }
}

const repo = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'repo',
  path,
  ...extra
})
const BOB = "fix Bob's bug"
const MODEL = "claude '--model' 'sonnet'"
const CODEX = "codex '--dangerously-bypass-approvals-and-sandbox'"
const posix = { command: `${MODEL} 'fix Bob'"'"'s bug'`, agentCommand: MODEL }
const powershell = { command: `${MODEL} 'fix Bob''s bug'`, agentCommand: MODEL }
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
const claude = { agent: 'claude', prompt: BOB } as const

const CASES: QuickCase[] = [
  quickCase('macOS repo', 'darwin', repo(POSIX_PATH), claude, ['darwin', undefined], posix),
  quickCase(
    'macOS repo, codex',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'codex', prompt: BOB },
    ['darwin', undefined],
    { command: `${CODEX} 'fix Bob'"'"'s bug'`, agentCommand: CODEX }
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
      command: `claude "--model" "sonnet" "fix Bob's bug"`,
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
  // The local shell setting never reaches an SSH target; its path decides the quoting.
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
    'macOS repo, no prompt',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'claude' },
    ['darwin', undefined],
    { command: MODEL, agentCommand: MODEL }
  ),
  quickCase(
    'macOS repo, onboarding',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'claude', prompt: 'hi', telemetrySource: 'onboarding' },
    ['darwin', undefined],
    { command: `${MODEL} 'hi'`, agentCommand: MODEL }
  ),
  quickCase(
    'macOS repo, claude native draft',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'claude', draftPrompt: 'draft me' },
    ['darwin', undefined],
    { command: `${MODEL} --prefill 'draft me'`, agentCommand: MODEL }
  ),
  // A draft without a native prefill, or a prompt typed after start, stays with the window.
  quickCase(
    'macOS repo, codex draft',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'codex', draftPrompt: 'draft me' },
    ['darwin', undefined],
    null
  ),
  quickCase(
    'macOS repo, aider prompt',
    'darwin',
    repo(POSIX_PATH),
    { agent: 'aider', prompt: 'fix it' },
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
            ...(c.agent === 'codex' ? { startupCommandDelivery: 'shell-ready' } : {}),
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
