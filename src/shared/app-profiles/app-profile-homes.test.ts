import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let first: string
let second: string

// Two temp homes stand for the user's home: a site that keeps the first one built its path at load.
beforeEach(() => {
  first = mkdtempSync(join(tmpdir(), 'orca-homes-first-'))
  second = mkdtempSync(join(tmpdir(), 'orca-homes-second-'))
  vi.stubEnv('HOME', first)
  for (const variable of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'KIRO_HOME']) {
    vi.stubEnv(variable, undefined)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(first, { recursive: true, force: true })
  rmSync(second, { recursive: true, force: true })
})

it("builds each rewritten site's path in the user's home when it runs", async () => {
  const { getSharedManagedScriptPath } =
    await import('../../main/agent-hooks/installation/scripts/managed-hook-script-path')
  const { getUserKeybindingsPath } = await import('../../main/keybindings/keybinding-file')
  const { getSystemCodexHomePath } =
    await import('../../main/codex/configuration/homes/codex-home-paths')
  const { getWorkspaceFilePath } =
    await import('../../main/linear/accounts/linear-credential-paths')
  const { codexHomeSessionsDir } =
    await import('../../main/ai-vault/discovery/session-scanner-roots')
  const { AI_VAULT_AGENT_SOURCES, defaultCodexHomeDir } =
    await import('../../main/ai-vault/discovery/session-scanner-agent-sources')
  const { getClaudePluginMetadataPaths } =
    await import('../../main/skills/discovery/claude-plugin-skill-sources')
  const { buildSkillDiscoverySources } =
    await import('../../main/skills/discovery/skill-discovery-sources')
  vi.stubEnv('HOME', second)
  expect(homedir()).toBe(second)
  const sources = buildSkillDiscoverySources({ homeDir: homedir(), cwd: '/repo' })
  const skillRoot = (id: string): string => sources.find((source) => source.id === id)!.path
  expect({
    hookScript: getSharedManagedScriptPath('claude-hook.sh'),
    keybindings: getUserKeybindingsPath(homedir()),
    codexHome: getSystemCodexHomePath(),
    linear: getWorkspaceFilePath(),
    codexSessions: codexHomeSessionsDir(),
    codexDefault: defaultCodexHomeDir(),
    claudePlugins: getClaudePluginMetadataPaths(homedir(), '/repo').installedPlugins,
    kiroSessions: AI_VAULT_AGENT_SOURCES.kiro!.rootDirs({}, [])[0],
    codexSkills: skillRoot('home-codex'),
    copilotSkills: skillRoot('home-copilot')
  }).toEqual({
    hookScript: join(second, '.orca', 'agent-hooks', 'claude-hook.sh'),
    keybindings: join(second, '.orca', 'keybindings.json'),
    codexHome: join(second, '.codex'),
    linear: expect.stringMatching(new RegExp(`^${second}\\${sep}\\.orca\\${sep}`)),
    codexSessions: join(second, '.codex', 'sessions'),
    codexDefault: join(second, '.codex'),
    claudePlugins: join(second, '.claude', 'plugins', 'installed_plugins.json'),
    kiroSessions: join(second, '.kiro', 'sessions', 'cli'),
    codexSkills: join(second, '.codex', 'skills'),
    copilotSkills: join(second, '.copilot', 'skills')
  })
})
