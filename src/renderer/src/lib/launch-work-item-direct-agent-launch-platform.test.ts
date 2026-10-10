import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tuiAgentToAgentKind } from '../../../shared/agent-kind'
import type * as SourceControlPlatformNamespace from './source-control-launch-platform'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
// Why: the real agent-kind mapping keeps the pinned telemetry payload byte-exact.
vi.mock('@/lib/telemetry', () => ({ track: vi.fn(), tuiAgentToAgentKind }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, value: string) => value
}))

import {
  buildDirectWorkItemAgentStartupPlan,
  buildDirectWorkItemStartupOpts
} from './launch-work-item-direct-agent'

type Client = 'win32' | 'darwin'
type SourceControlPlatformModule = typeof SourceControlPlatformNamespace

const USER_AGENT: Record<Client, string> = {
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orca',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orca'
}
const WSL_RUNTIME = {
  status: 'resolved' as const,
  runtime: {
    kind: 'wsl' as const,
    hostPlatform: 'wsl' as const,
    distro: 'Ubuntu',
    reason: 'project-override' as const,
    projectId: 'repo-1',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}
const moduleByClient = new Map<Client, SourceControlPlatformModule>()

async function loadForClient(client: Client): Promise<SourceControlPlatformModule> {
  // Why: CLIENT_PLATFORM reads the user agent once, at import.
  vi.stubGlobal('navigator', { userAgent: USER_AGENT[client] })
  const cached = moduleByClient.get(client)
  if (cached) {
    return cached
  }
  vi.resetModules()
  const loaded = await import('./source-control-launch-platform')
  moduleByClient.set(client, loaded)
  return loaded
}

// Pins main's current launch behaviour as the convergence parity baseline (row 8 work item, rule
// SOURCE_CONTROL_PLATFORM): which platform the work-item direct launch quotes for.
describe('SOURCE_CONTROL_PLATFORM: resolveSourceControlLaunchPlatform on main', () => {
  // Why: the first import transforms the whole store graph; keep that out of the first case.
  beforeAll(async () => {
    await loadForClient('win32')
    await loadForClient('darwin')
  }, 120_000)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Why: \\wsl$ paths, C:\ paths and WSL runtimes only exist locally on a Windows client, so the
  // macOS client keeps the local POSIX repo and the two SSH cases.
  it.each([
    {
      client: 'win32' as const,
      name: 'local C:\\ repo',
      args: { connectionId: null, worktreePath: String.raw`C:\Users\alice\repo` },
      expected: 'win32'
    },
    {
      client: 'win32' as const,
      name: 'local \\\\wsl$ repo',
      args: { connectionId: null, worktreePath: String.raw`\\wsl$\Ubuntu\home\alice\repo` },
      expected: 'linux'
    },
    {
      client: 'win32' as const,
      name: 'local C:\\ repo with a WSL project runtime',
      args: {
        connectionId: null,
        worktreePath: String.raw`C:\Users\alice\repo`,
        projectRuntime: WSL_RUNTIME
      },
      expected: 'linux'
    },
    {
      client: 'win32' as const,
      name: 'SSH POSIX repo',
      args: { connectionId: 'ssh-1', worktreePath: '/home/alice/repo' },
      expected: 'linux'
    },
    {
      client: 'win32' as const,
      name: 'SSH C:\\ repo',
      args: { connectionId: 'ssh-1', worktreePath: String.raw`C:\Users\alice\repo` },
      expected: 'win32'
    },
    {
      client: 'darwin' as const,
      name: 'local POSIX repo',
      args: { connectionId: null, worktreePath: '/Users/alice/repo' },
      expected: 'darwin'
    },
    {
      client: 'darwin' as const,
      name: 'SSH POSIX repo',
      args: { connectionId: 'ssh-1', worktreePath: '/home/alice/repo' },
      expected: 'linux'
    },
    {
      client: 'darwin' as const,
      name: 'SSH C:\\ repo',
      args: { connectionId: 'ssh-1', worktreePath: String.raw`C:\Users\alice\repo` },
      expected: 'win32'
    }
  ])('$client client, $name -> $expected', async ({ client, args, expected }) => {
    const { resolveSourceControlLaunchPlatform } = await loadForClient(client)

    expect(resolveSourceControlLaunchPlatform(args)).toBe(expected)
  })
})

// terminalWindowsShell is not in the planner's settings type, but the work item hands it the whole
// AppState settings, so the field is present at runtime and still ignored.
const CMD_SHELL_SETTINGS = {
  terminalWindowsShell: 'cmd.exe',
  agentCmdOverrides: {},
  agentDefaultArgs: { claude: `--append-system-prompt "it's fine"` },
  agentDefaultEnv: {}
}
const DRAFT = "Fix Bob's bug"

// Pins main's current launch behaviour as the convergence parity baseline (row 8 work item, rule
// SOURCE_CONTROL_PLATFORM): no shell is passed, so win32 always quotes for PowerShell, even with cmd.exe.
describe('row 8: work-item direct startup command and opts on main', () => {
  it.each([
    {
      name: 'win32 Claude draft (native prefill)',
      launchPlatform: 'win32' as const,
      promptDelivery: 'draft' as const,
      expectedPlan: {
        agent: 'claude',
        launchCommand: `claude '--append-system-prompt' 'it''s fine' --prefill 'Fix Bob''s bug'`,
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: {
          agentCommand: `claude '--append-system-prompt' 'it''s fine'`,
          agentArgs: `--append-system-prompt "it's fine"`,
          agentEnv: {}
        },
        env: {}
      }
    },
    {
      name: 'win32 Claude submit-after-ready',
      launchPlatform: 'win32' as const,
      promptDelivery: 'submit-after-ready' as const,
      expectedPlan: {
        agent: 'claude',
        launchCommand: `claude '--append-system-prompt' 'it''s fine'`,
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: {
          agentCommand: `claude '--append-system-prompt' 'it''s fine'`,
          agentArgs: `--append-system-prompt "it's fine"`,
          agentEnv: {}
        },
        env: {}
      }
    },
    {
      // Contrast: a WSL or SSH POSIX work item gets POSIX quoting from the same settings.
      name: 'linux Claude draft (native prefill)',
      launchPlatform: 'linux' as const,
      promptDelivery: 'draft' as const,
      expectedPlan: {
        agent: 'claude',
        launchCommand: `claude '--append-system-prompt' 'it'"'"'s fine' --prefill 'Fix Bob'"'"'s bug'`,
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: {
          agentCommand: `claude '--append-system-prompt' 'it'"'"'s fine'`,
          agentArgs: `--append-system-prompt "it's fine"`,
          agentEnv: {}
        },
        env: {}
      }
    }
  ])('$name', ({ launchPlatform, promptDelivery, expectedPlan }) => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'claude',
      draftContent: DRAFT,
      promptDelivery,
      settings: CMD_SHELL_SETTINGS,
      launchPlatform
    })

    expect(result).toStrictEqual({
      startupPlan: expectedPlan,
      draftLaunchedNatively: promptDelivery === 'draft',
      startupPlanFailed: false
    })
    expect(buildDirectWorkItemStartupOpts('claude', result.startupPlan, 'task_page')).toStrictEqual(
      {
        startup: {
          command: expectedPlan.launchCommand,
          env: {},
          launchConfig: expectedPlan.launchConfig,
          launchAgent: 'claude',
          telemetry: { agent_kind: 'claude-code', launch_source: 'task_page', request_kind: 'new' }
        }
      }
    )
  })

  it.each(['task_page', 'sidebar', 'source_control_recovery'] as const)(
    'telemetry launch_source is the caller value %s',
    (launchSource) => {
      const { startupPlan } = buildDirectWorkItemAgentStartupPlan({
        agent: 'codex',
        draftContent: DRAFT,
        promptDelivery: 'draft',
        settings: CMD_SHELL_SETTINGS,
        launchPlatform: 'win32'
      })

      // main today: Codex has no native draft flag, so the draft rides as draftPrompt for a later
      // paste and the command carries only the built-in default args.
      expect(buildDirectWorkItemStartupOpts('codex', startupPlan, launchSource)).toStrictEqual({
        startup: {
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          env: {},
          launchConfig: {
            agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          },
          launchAgent: 'codex',
          draftPrompt: DRAFT,
          telemetry: { agent_kind: 'codex', launch_source: launchSource, request_kind: 'new' }
        }
      })
    }
  )
})
