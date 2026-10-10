import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tuiAgentToAgentKind } from '../../../shared/agent-kind'
import { perClientLoader } from '@/lib/launch-parity-renderer-fixture'
import type { LaunchClient } from '../../../shared/launch-parity-window-request.test-fixture'
import {
  POSIX_PATH,
  WIN_PATH,
  WSL_PATH
} from '../../../shared/launch-parity-window-cases.test-fixture'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
// Why: the real agent-kind mapping keeps the pinned telemetry payload byte-exact.
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))

const load = perClientLoader(async () => ({
  platform: await import('./source-control-launch-platform'),
  direct: await import('./launch-work-item-direct-agent')
}))

const WSL_RUNTIME = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    distro: 'Ubuntu',
    reason: 'project-override',
    projectId: 'repo-1',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
} as const
// terminalWindowsShell is not in the planner's settings type, but the work item hands it the whole
// AppState settings, so the field is present at runtime and still ignored.
const CMD_SHELL_SETTINGS = {
  terminalWindowsShell: 'cmd.exe',
  agentCmdOverrides: {},
  agentDefaultArgs: { claude: `--append-system-prompt "it's fine"` },
  agentDefaultEnv: {}
}
const ARGS = `--append-system-prompt "it's fine"`
const POWERSHELL = {
  agentCommand: `claude '--append-system-prompt' 'it''s fine'`,
  draft: ` --prefill 'Fix Bob''s bug'`
}
const POSIX = {
  agentCommand: `claude '--append-system-prompt' 'it'"'"'s fine'`,
  draft: ` --prefill 'Fix Bob'"'"'s bug'`
}

type WorkItemCase = {
  name: string
  client: LaunchClient
  where: { connectionId: string | null; worktreePath: string; projectRuntime?: typeof WSL_RUNTIME }
  platform: NodeJS.Platform
  quoting: typeof POSIX
}

// Why: \\wsl$ paths, C:\ paths and WSL runtimes only exist locally on a Windows client.
const CASES: WorkItemCase[] = [
  {
    name: 'local C: repo',
    client: 'win32',
    where: { connectionId: null, worktreePath: WIN_PATH },
    platform: 'win32',
    quoting: POWERSHELL
  },
  {
    name: 'local wsl$ repo',
    client: 'win32',
    where: { connectionId: null, worktreePath: WSL_PATH },
    platform: 'linux',
    quoting: POSIX
  },
  {
    name: 'local C: repo, WSL project runtime',
    client: 'win32',
    where: { connectionId: null, worktreePath: WIN_PATH, projectRuntime: WSL_RUNTIME },
    platform: 'linux',
    quoting: POSIX
  },
  {
    name: 'SSH POSIX repo',
    client: 'win32',
    where: { connectionId: 'ssh-1', worktreePath: POSIX_PATH },
    platform: 'linux',
    quoting: POSIX
  },
  {
    name: 'SSH C: repo',
    client: 'win32',
    where: { connectionId: 'ssh-1', worktreePath: WIN_PATH },
    platform: 'win32',
    quoting: POWERSHELL
  },
  {
    name: 'local POSIX repo',
    client: 'darwin',
    where: { connectionId: null, worktreePath: POSIX_PATH },
    platform: 'darwin',
    quoting: POSIX
  },
  {
    name: 'SSH C: repo',
    client: 'darwin',
    where: { connectionId: 'ssh-1', worktreePath: WIN_PATH },
    platform: 'win32',
    quoting: POWERSHELL
  }
]

// Pins main's current launch behaviour as the convergence parity baseline (row 8 work item, rule
// SOURCE_CONTROL_PLATFORM): the platform a work-item launch quotes for, and the startup it opens
// the workspace with. No shell is passed, so win32 quotes for PowerShell even with cmd.exe set.
describe('row 8: work-item direct agent launch on main', () => {
  beforeAll(async () => {
    await load('win32')
    await load('darwin')
  }, 240_000)
  afterEach(() => vi.unstubAllGlobals())

  it.each(
    CASES.flatMap((c) =>
      (['draft', 'submit-after-ready'] as const).map((promptDelivery) => ({ ...c, promptDelivery }))
    )
  )('$client client, $name, $promptDelivery', async (c) => {
    const { platform, direct } = await load(c.client)
    const launchPlatform = platform.resolveSourceControlLaunchPlatform(c.where)
    expect(launchPlatform).toBe(c.platform)

    const result = direct.buildDirectWorkItemAgentStartupPlan({
      agent: 'claude',
      draftContent: "Fix Bob's bug",
      promptDelivery: c.promptDelivery,
      settings: CMD_SHELL_SETTINGS,
      launchPlatform
    })
    const launchConfig = { agentCommand: c.quoting.agentCommand, agentArgs: ARGS, agentEnv: {} }
    // A Claude draft rides --prefill; submit-after-ready leaves the prompt for later.
    const command = `${c.quoting.agentCommand}${c.promptDelivery === 'draft' ? c.quoting.draft : ''}`
    expect(result).toEqual({
      startupPlan: {
        agent: 'claude',
        launchCommand: command,
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig,
        env: {}
      },
      draftLaunchedNatively: c.promptDelivery === 'draft',
      startupPlanFailed: false
    })
    expect(
      direct.buildDirectWorkItemStartupOpts('claude', result.startupPlan, 'task_page')
    ).toEqual({
      startup: {
        command,
        env: {},
        launchConfig,
        launchAgent: 'claude',
        telemetry: { agent_kind: 'claude-code', launch_source: 'task_page', request_kind: 'new' }
      }
    })
  })

  it.each(['task_page', 'sidebar', 'source_control_recovery'] as const)(
    'a codex draft rides as draftPrompt, launch_source %s',
    async (launchSource) => {
      const { direct } = await load('win32')
      const { startupPlan } = direct.buildDirectWorkItemAgentStartupPlan({
        agent: 'codex',
        draftContent: "Fix Bob's bug",
        promptDelivery: 'draft',
        settings: CMD_SHELL_SETTINGS,
        launchPlatform: 'win32'
      })
      const codex = "codex '--dangerously-bypass-approvals-and-sandbox'"
      // main today: Codex has no native draft flag, so the draft waits for a later paste.
      expect(direct.buildDirectWorkItemStartupOpts('codex', startupPlan, launchSource)).toEqual({
        startup: {
          command: codex,
          env: {},
          launchConfig: {
            agentCommand: codex,
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          },
          launchAgent: 'codex',
          draftPrompt: "Fix Bob's bug",
          telemetry: { agent_kind: 'codex', launch_source: launchSource, request_kind: 'new' }
        }
      })
    }
  )
})
