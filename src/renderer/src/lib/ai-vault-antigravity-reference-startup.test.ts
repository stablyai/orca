import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type * as ResumeModuleNamespace from './ai-vault-resume-command'
import type * as ReferenceModuleNamespace from './ai-vault-antigravity-reference-startup'
import type { ExecutionHostId } from '../../../shared/execution-host'

type Client = 'darwin' | 'win32'
type State = Parameters<ResumeModule['buildAiVaultResumeStartupForWorktree']>[0]['state']
type ResumeModule = typeof ResumeModuleNamespace
type ReferenceModule = typeof ReferenceModuleNamespace

const USER_AGENT: Record<Client, string> = {
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Orca',
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orca'
}
const loaded = new Map<Client, { resume: ResumeModule; reference: ReferenceModule }>()

async function loadForClient(
  client: Client
): Promise<{ resume: ResumeModule; reference: ReferenceModule }> {
  // Why: CLIENT_PLATFORM reads the user agent at import, the renderer app platform at call time.
  vi.stubGlobal('navigator', { userAgent: USER_AGENT[client] })
  const cached = loaded.get(client)
  if (cached) {
    return cached
  }
  vi.resetModules()
  const modules = {
    resume: await import('./ai-vault-resume-command'),
    reference: await import('./ai-vault-antigravity-reference-startup')
  }
  loaded.set(client, modules)
  return modules
}

const AGY_ENV = { AGY_CLI_HIDE_ACCOUNT_INFO: '1' }
const AGY_ARGS = '--model claude-sonnet-4-6'
const LAUNCH_CONFIG = {
  agentCommand: "agy '--model' 'claude-sonnet-4-6'",
  agentArgs: AGY_ARGS,
  agentEnv: AGY_ENV
}

function referencePrompt(path: string): string {
  return `Review the chat transcript at "${path}". Confirm your understanding of the previous conversation and continue from where it left off. This starts a new CLI conversation using the original transcript as a reference.`
}

function stateFor(args: {
  host: ExecutionHostId
  path: string
  distro?: string
  terminalWindowsShell?: string
}): State {
  const worktree = makeWorktree({
    id: 'repo::workspace',
    repoId: 'repo',
    hostId: args.host,
    path: args.path
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume builder reads only agentCmdOverrides, agentDefaultArgs, agentDefaultEnv, terminalWindowsShell and localWindowsRuntimeDefault from settings.
  const settings = {
    agentCmdOverrides: {},
    agentDefaultArgs: { antigravity: AGY_ARGS },
    agentDefaultEnv: { antigravity: AGY_ENV },
    localWindowsRuntimeDefault: { kind: 'windows-host' },
    ...(args.terminalWindowsShell ? { terminalWindowsShell: args.terminalWindowsShell } : {})
  } as unknown as State['settings']
  return {
    activeRepoId: 'repo',
    activeWorktreeId: worktree.id,
    folderWorkspaces: [],
    projectGroups: [],
    settings,
    repos: [
      {
        id: 'repo',
        path: worktree.path,
        displayName: 'project',
        badgeColor: '',
        addedAt: 0,
        projectGroupId: 'group-1',
        executionHostId: args.host
      }
    ],
    projects: [
      {
        id: 'repo',
        displayName: 'project',
        badgeColor: '',
        sourceRepoIds: ['repo'],
        createdAt: 0,
        updatedAt: 0,
        localWindowsRuntimePreference: args.distro
          ? { kind: 'wsl', distro: args.distro }
          : { kind: 'windows-host' }
      }
    ],
    worktreesByRepo: { repo: [worktree] }
  }
}

const MAC_FILE = '/Users/alice/.gemini/antigravity-ide/brain/ide-id/transcript_full.jsonl'
const WIN_FILE = 'C:/Users/alice/.gemini/antigravity-ide/brain/ide-id/transcript_full.jsonl'
const LINUX_FILE = '/home/alice/.gemini/antigravity-ide/brain/ide-id/transcript_full.jsonl'
const WSL_FILE =
  '//wsl.localhost/Debian/home/alice/.gemini/antigravity-ide/brain/ide-id/transcript_full.jsonl'

const CASES = [
  {
    name: 'darwin local',
    client: 'darwin',
    state: { host: 'local', path: '/Users/alice/project' },
    session: { executionHostId: 'local', filePath: MAC_FILE, cwd: '/Users/alice/project' },
    command: `agy '--model' 'claude-sonnet-4-6' --prompt-interactive '${referencePrompt(MAC_FILE)}'`,
    cwd: '/Users/alice/project'
  },
  {
    name: 'win32 local PowerShell',
    client: 'win32',
    state: { host: 'local', path: 'C:/project', terminalWindowsShell: 'powershell.exe' },
    session: { executionHostId: 'local', filePath: WIN_FILE, cwd: 'C:\\project' },
    command: `agy '--model' 'claude-sonnet-4-6' --prompt-interactive '${referencePrompt(WIN_FILE)}'`,
    cwd: 'C:\\project'
  },
  {
    name: 'win32 local cmd.exe',
    client: 'win32',
    state: { host: 'local', path: 'C:/project', terminalWindowsShell: 'cmd.exe' },
    session: { executionHostId: 'local', filePath: WIN_FILE, cwd: 'C:\\project' },
    // cmd escapes the prompt's inner quotes with a caret.
    command: `agy "--model" "claude-sonnet-4-6" --prompt-interactive "${referencePrompt(WIN_FILE).replace(/"/g, '^"')}"`,
    cwd: 'C:\\project',
    agentCommand: 'agy "--model" "claude-sonnet-4-6"'
  },
  {
    // The UNC transcript path is rewritten to its Linux spelling inside the prompt.
    name: 'win32 local WSL UNC',
    client: 'win32',
    state: {
      host: 'local',
      path: '//wsl.localhost/Debian/home/alice/project',
      distro: 'Debian',
      terminalWindowsShell: 'powershell.exe'
    },
    session: { executionHostId: 'local', filePath: WSL_FILE, cwd: '/home/alice/project' },
    command: `agy '--model' 'claude-sonnet-4-6' --prompt-interactive '${referencePrompt(LINUX_FILE)}'`,
    cwd: '/home/alice/project'
  },
  {
    // A Windows client's shell setting does not reach an SSH Linux host.
    name: 'win32 client, SSH linux',
    client: 'win32',
    state: { host: 'ssh:owner', path: '/home/alice/project', terminalWindowsShell: 'cmd.exe' },
    session: {
      executionHostId: 'ssh:owner',
      executionHostPlatform: 'linux',
      filePath: LINUX_FILE,
      cwd: '/home/alice/project'
    },
    command: `agy '--model' 'claude-sonnet-4-6' --prompt-interactive '${referencePrompt(LINUX_FILE)}'`,
    cwd: '/home/alice/project'
  }
] as const

// Pins main's current launch behaviour as the convergence parity baseline (row 6): the exact startup an Antigravity "continue from transcript" queues, per host.
describe('row 6: Antigravity reference startup on main', () => {
  // Why: the first import transforms the whole store graph; keep that out of the first case.
  beforeAll(async () => {
    await loadForClient('darwin')
    await loadForClient('win32')
  }, 120_000)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(CASES)('$name', async (c) => {
    const { resume } = await loadForClient(c.client)
    const startup = resume.buildAiVaultResumeStartupForWorktree({
      state: stateFor(c.state),
      worktreeId: 'repo::workspace',
      session: {
        agent: 'antigravity',
        sessionId: 'ide-id',
        codexHome: null,
        // A stale resume line must not win over the fresh reference launch.
        resumeCommand: 'agy --conversation ide-id',
        ...c.session
      }
    })

    // No cd prefix, no providerSession: the cwd rides on the tab and the conversation is new.
    expect(startup).toStrictEqual({
      command: c.command,
      env: AGY_ENV,
      launchConfig: {
        ...LAUNCH_CONFIG,
        ...('agentCommand' in c ? { agentCommand: c.agentCommand } : {})
      },
      cwd: c.cwd
    })
  })

  it('omits cwd when the session has none', async () => {
    const { resume } = await loadForClient('darwin')
    expect(
      resume.buildAiVaultResumeStartupForWorktree({
        state: stateFor({ host: 'local', path: '/Users/alice/project' }),
        worktreeId: 'repo::workspace',
        session: {
          agent: 'antigravity',
          sessionId: 'ide-id',
          codexHome: null,
          cwd: null,
          filePath: MAC_FILE
        }
      })
    ).toStrictEqual({
      command: `agy '--model' 'claude-sonnet-4-6' --prompt-interactive '${referencePrompt(MAC_FILE)}'`,
      env: AGY_ENV,
      launchConfig: LAUNCH_CONFIG
    })
  })

  it('a command override replaces agy but keeps the default args and env', async () => {
    const { reference } = await loadForClient('darwin')
    expect(
      reference.buildAntigravityReferenceStartup({
        session: { sessionId: 'ide-id', filePath: MAC_FILE },
        cwd: null,
        platform: 'darwin',
        commandOverride: '/opt/agy/bin/agy',
        settings: {
          agentDefaultArgs: { antigravity: AGY_ARGS },
          agentDefaultEnv: { antigravity: AGY_ENV }
        }
      })
    ).toStrictEqual({
      command: `/opt/agy/bin/agy '--model' 'claude-sonnet-4-6' --prompt-interactive '${referencePrompt(MAC_FILE)}'`,
      env: AGY_ENV,
      launchConfig: {
        agentCommand: "/opt/agy/bin/agy '--model' 'claude-sonnet-4-6'",
        agentArgs: AGY_ARGS,
        agentEnv: AGY_ENV
      }
    })
  })
})
