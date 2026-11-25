import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_PROFILE_AGENT_HOME_VARIABLES,
  APP_PROFILE_HOME_ENV_KEYS,
  agentHomeDirIn,
  applyAppProfileHomes,
  defaultAgentHomeDir,
  defaultClaudeJsonPath,
  orcaHomeDir,
  type AppProfileAgentHomeVariable
} from './app-profile-homes'

let home: string
let work: string
let other: string

function profileFolder(id: string): string {
  const folder = join(home, 'Orca Profiles', id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'orca-app-profile.json'), JSON.stringify({ id }))
  return folder
}

// A temp HOME stands for the user's home: nothing here may resolve inside it.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-profile-homes-'))
  // os.homedir() reads USERPROFILE on Windows.
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  for (const key of APP_PROFILE_HOME_ENV_KEYS) {
    vi.stubEnv(key, undefined)
  }
  work = profileFolder('work')
  other = profileFolder('other')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(home, { recursive: true, force: true })
})

const underProfile = (path: string): boolean => path.startsWith(work + sep)

describe('app profile homes', () => {
  it("replace every value in a profile, also the user's", () => {
    const env: NodeJS.ProcessEnv = { CODEX_HOME: '/user/codex' }
    applyAppProfileHomes(other, env)
    expect(env.CODEX_HOME).toBe(join(other, 'orca-home', 'agents', 'codex'))
    applyAppProfileHomes(work, env)
    expect(env.CODEX_HOME).toBe(join(work, 'orca-home', 'agents', 'codex'))
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(work, 'orca-home', 'agents', 'claude'))
  })

  it("remove only a profile's values in the default app", () => {
    const env: NodeJS.ProcessEnv = {}
    applyAppProfileHomes(work, env)
    // A shell startup file may export its own value after the profile; it is the user's.
    env.GROK_HOME = '/user/grok'
    // An `orca-home` folder outside the profile's is the user's too.
    env.QWEN_HOME = join(home, 'not-a-profile', 'orca-home', 'qwen')
    applyAppProfileHomes(null, env)
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_HOME_DIR).toBeUndefined()
    expect(env).toMatchObject({
      GROK_HOME: '/user/grok',
      QWEN_HOME: join(home, 'not-a-profile', 'orca-home', 'qwen')
    })
  })

  it('resolve every helper path under the profile folder', () => {
    applyAppProfileHomes(work, process.env)
    expect(homedir()).toBe(home)
    const paths = [
      orcaHomeDir(),
      orcaHomeDir(homedir()),
      defaultClaudeJsonPath(),
      ...Object.keys(APP_PROFILE_AGENT_HOME_VARIABLES)
        .filter(
          (key): key is AppProfileAgentHomeVariable => key in APP_PROFILE_AGENT_HOME_VARIABLES
        )
        .flatMap((variable) => [
          defaultAgentHomeDir(variable, '.agent'),
          agentHomeDirIn(homedir(), variable, '.agent')
        ])
    ]
    expect(paths.filter((path) => !underProfile(path))).toEqual([])
    // Another host's home keeps its own folders.
    expect(orcaHomeDir('/remote/home')).toBe('/remote/home/.orca')
    expect(agentHomeDirIn('/remote/home', 'CODEX_HOME', '.codex')).toBe('/remote/home/.codex')
  })

  it("honour an agent value only under the profile's ORCA_HOME_DIR", () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/user/claude')
    vi.stubEnv('CODEX_HOME', join(work, 'orca-home', 'agents', 'codex'))
    // No ORCA_HOME_DIR: the default app. A value from a profile that is gone is not honoured.
    expect(orcaHomeDir()).toBe(join(home, '.orca'))
    expect(defaultAgentHomeDir('CODEX_HOME', '.codex')).toBe(join(home, '.codex'))
    vi.stubEnv('ORCA_HOME_DIR', join(work, 'orca-home'))
    expect(defaultAgentHomeDir('CODEX_HOME', '.codex')).toBe(
      join(work, 'orca-home', 'agents', 'codex')
    )
    // The user's own value outside the profile folder.
    expect(defaultAgentHomeDir('CLAUDE_CONFIG_DIR', '.claude')).toBe(join(home, '.claude'))
    expect(defaultClaudeJsonPath()).toBe(join(home, '.claude.json'))
  })

  it('resolve the rewritten sites under the profile folder, also when imported first', async () => {
    // Imported before the env is set: a path that a module builds at load fails here.
    const { getSharedManagedScriptPath } =
      await import('../../main/agent-hooks/installation/scripts/managed-hook-script-path')
    const { getUserKeybindingsPath } = await import('../../main/keybindings/keybinding-file')
    const { getSystemCodexHomePath, getLocalCodexTrustConfigFiles } =
      await import('../../main/codex/configuration/homes/codex-home-paths')
    const { getWorkspaceFilePath } =
      await import('../../main/linear/accounts/linear-credential-paths')
    const { claudeProjectsHostDirs, codexHomeSessionsDir } =
      await import('../../main/ai-vault/discovery/session-scanner-roots')
    const { AI_VAULT_AGENT_SOURCES, defaultCodexHomeDir } =
      await import('../../main/ai-vault/discovery/session-scanner-agent-sources')
    const { getClaudePluginMetadataPaths } =
      await import('../../main/skills/discovery/claude-plugin-skill-sources')
    const { buildSkillDiscoverySources } =
      await import('../../main/skills/discovery/skill-discovery-sources')
    const { resolveEnvironmentSkillProviderRoots } =
      await import('../../main/skills/providers/skill-provider-runtime-roots')
    applyAppProfileHomes(work, process.env)
    const sources = buildSkillDiscoverySources({ homeDir: homedir(), cwd: '/repo' })
    const skillRoot = (id: string): string => sources.find((source) => source.id === id)!.path
    const installRoots = resolveEnvironmentSkillProviderRoots(process.env, homedir())
    const paths = [
      getSharedManagedScriptPath('claude-hook.sh'),
      getUserKeybindingsPath(homedir()),
      getSystemCodexHomePath(),
      getLocalCodexTrustConfigFiles(homedir()).at(-1)!,
      getWorkspaceFilePath(),
      ...claudeProjectsHostDirs(),
      codexHomeSessionsDir(),
      defaultCodexHomeDir(),
      getClaudePluginMetadataPaths(homedir(), '/repo').installedPlugins,
      ...(['copilot', 'kiro', 'cline', 'codebuddy', 'openclaw'] as const).map(
        (agent) => AI_VAULT_AGENT_SOURCES[agent]!.rootDirs({}, [])[0]
      ),
      ...['home-codex', 'codex-plugin-cache', 'home-qoder', 'home-copilot'].map(skillRoot),
      ...(['claude', 'grok', 'codebuddy', 'kiro'] as const).map(
        (id) => installRoots[id] ?? `missing ${id}`
      )
    ]
    expect(paths.filter((path) => !underProfile(path))).toEqual([])
  })

  it("read only the profile's Claude config, OpenClaw sessions and Codex lock", async () => {
    const { AI_VAULT_AGENT_SOURCES } =
      await import('../../main/ai-vault/discovery/session-scanner-agent-sources')
    const { readClaudeInheritedTools } = await import('../../main/bots/bot-tools-claude')
    const { readClaudeDiffPanelPreference } =
      await import('../../main/claude/configuration/claude-diff-panel-auto-open')
    const { resolveCodexHomeProcessLockKeyForSpawnEnv: lockKey } =
      await import('../../main/codex-cli/codex-home-process-lock')
    const read = async (): Promise<unknown> => ({
      openclaw: AI_VAULT_AGENT_SOURCES.openclaw!.rootDirs({}, []),
      tools: await readClaudeInheritedTools(null),
      diffPanel: await readClaudeDiffPanelPreference({ configDirEnv: undefined })
    })
    const claude = join(work, 'orca-home', 'agents', 'claude')
    mkdirSync(claude, { recursive: true })
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { user: {} }, diffSidebarOpen: true })
    )
    writeFileSync(
      join(claude, '.claude.json'),
      JSON.stringify({ mcpServers: { work: {} }, diffSidebarOpen: false })
    )
    const openclaw = (root: string): string => join(root, 'agents')
    expect(await read()).toEqual({
      openclaw: [openclaw(join(home, '.openclaw')), openclaw(join(home, '.clawdbot'))],
      tools: [{ name: 'user' }],
      diffPanel: true
    })
    applyAppProfileHomes(work, process.env)
    expect(await read()).toEqual({
      openclaw: [openclaw(join(work, 'orca-home', 'agents', 'openclaw'))],
      tools: [{ name: 'work' }],
      diffPanel: false
    })
    // A Codex child env without CODEX_HOME runs Codex in ~/.codex.
    expect(lockKey({})).toBe(lockKey({ CODEX_HOME: join(home, '.codex') }))
    expect(lockKey(undefined)).toBe(
      lockKey({ CODEX_HOME: join(work, 'orca-home', 'agents', 'codex') })
    )
  })

  it('write workspace trust into the profile folders, not the user home', async () => {
    const { applyWorkspaceTrustOnThisHost } =
      await import('../../main/agent-launch/trust/execution-host-workspace-trust')
    applyAppProfileHomes(work, process.env)
    const workspace = join(home, 'repo')
    mkdirSync(workspace)
    for (const preset of ['copilot', 'qoder', 'kimi', 'qwen-code'] as const) {
      await applyWorkspaceTrustOnThisHost(preset, workspace, () => ({
        homes: [homedir()],
        agentHome: homedir(),
        claudeConfig: () => null,
        codexConfigFiles: () => [],
        agentEnv: {},
        deadlineMs: 5_000
      }))
    }
    const agents = join(work, 'orca-home', 'agents')
    expect(readdirSync(join(agents, 'copilot'))).toEqual(['config.json'])
    expect(readdirSync(join(agents, 'qoder'))).toEqual(['settings.json'])
    expect(readdirSync(join(agents, 'kimi-code'))).toEqual(['workspace-trust'])
    expect(readdirSync(join(agents, 'qwen'))).toEqual(['settings.json'])
    expect(readdirSync(home).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('leave the default app on the user home', () => {
    expect(orcaHomeDir()).toBe(join(home, '.orca'))
    expect(defaultAgentHomeDir('CLAUDE_CONFIG_DIR', '.claude')).toBe(join(home, '.claude'))
    expect(defaultClaudeJsonPath()).toBe(join(home, '.claude.json'))
  })
})
