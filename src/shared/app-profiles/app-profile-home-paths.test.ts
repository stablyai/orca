import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

// A raw path into the user's home for `~/.orca` or an agent folder bypasses the app profile's own
// folders. Production code builds these paths through src/shared/app-profiles/app-profile-homes.ts.
const ROOT = join(__dirname, '..', '..', '..')
// `~/.orca` and the folder of each agent in APP_PROFILE_AGENT_HOME_VARIABLES.
const AGENT_DIRS =
  'orca|claude|claude\\.json|codex|grok|copilot|hermes|kimi-code|kiro|openclaw|mimocode|qwen|qoder|codebuddy|cline'
const RAW_PATTERNS = [
  // join(homedir(), '.claude'), os.homedir() + '.claude.json', over a line break too.
  new RegExp(`homedir\\(\\)[^;]{0,60}?['"\`/]\\.(${AGENT_DIRS})(?![\\w.-])`, 'g'),
  // `${HOME}/.codex`, `${HOME-}/.orca`, "$HOME/.claude"
  new RegExp(`\\$\\{?HOME-?\\}?"?\\/\\.(${AGENT_DIRS})(?![\\w-])`, 'g'),
  // join(home, '.codex'), resolve(input.homeDir, '.claude'), join(env.X || home, '.qwen'):
  // a home held in a name.
  new RegExp(
    `(?:join|resolve)\\(\\s*[^,()]*?[Hh](?:ome|OME)[\\w.$]*\\s*,\\s*['"\`]\\.(${AGENT_DIRS})(?![\\w.-])`,
    'g'
  ),
  // `${home}/.grok`, `${input.homeDir}/.orca`
  new RegExp(`\\$\\{[\\w.]*[Hh](?:ome|OME)[\\w.]*\\}\\/\\.(${AGENT_DIRS})(?![\\w-])`, 'g'),
  // app.getPath('home') + '/.claude'
  new RegExp(`getPath\\(\\s*['"]home['"]\\s*\\)[^;]{0,60}?\\.(${AGENT_DIRS})(?![\\w.-])`, 'g')
]
// The variable that moves each folder: a path that reads it first follows the profile.
const FOLDER_VARIABLE: Record<string, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  grok: 'GROK_HOME',
  copilot: 'COPILOT_HOME',
  hermes: 'HERMES_HOME',
  'kimi-code': 'KIMI_CODE_HOME',
  kiro: 'KIRO_HOME',
  openclaw: 'OPENCLAW_STATE_DIR',
  mimocode: 'MIMOCODE_HOME',
  qwen: 'QWEN_HOME',
  qoder: 'QODER_CONFIG_DIR',
  codebuddy: 'CODEBUDDY_CONFIG_DIR',
  cline: 'CLINE_DIR'
}
// Each entry says why the raw path is right there. `line` limits it to lines that contain it.
type Allowed = { file: string; line?: string; reason: string }
const WSL = "a WSL guest's or another host's own home"
const ANTIGRAVITY = 'Antigravity has no folder variable; a profile installs no Antigravity hooks'
const ALLOWED: Allowed[] = [
  { file: 'src/shared/app-profiles/app-profile-homes.ts', reason: 'the helpers themselves' },
  { file: 'src/shared/app-profiles/app-profile-env-core.ts', reason: 'the helpers themselves' },
  {
    file: 'src/main/orcad/host-runtime/orcad-app-paths.ts',
    reason: "orcad's data folder, not ~/.orca"
  },
  {
    file: 'src/main/codebuddy/codebuddy-acp-launch-spec.ts',
    reason: 'used only when CODEBUDDY_CONFIG_DIR is unset; a profile sets it'
  },
  {
    file: 'src/main/hermes/hermes-default-home.ts',
    reason: 'used only when HERMES_HOME is unset; a profile sets it'
  },
  {
    file: 'src/main/agent-hooks/installation/commands/runtime-home-hook-command.ts',
    reason: 'hook commands; a profile installs no managed hooks'
  },
  {
    file: 'src/main/codex/hooks/definitions/codex-hook-command-form.ts',
    reason: 'frozen Codex hook command bytes; a profile installs no managed hooks'
  },
  { file: 'src/main/wsl/discovery/wsl-distro-holder-command.ts', reason: WSL },
  { file: 'src/main/wsl/host-lifecycle/wsl-host-ssh-orcad-conflict.ts', reason: WSL },
  { file: 'src/main/wsl/host-lifecycle/wsl-host-uninstall-server-stop.ts', reason: WSL },
  {
    file: 'src/main/ai-vault/scanners/opencode/reader-transport/opencode-wsl-runtime-preparation.ts',
    reason: WSL
  },
  { file: 'src/main/antigravity/native-wsl-credentials.ts', reason: WSL },
  { file: 'src/main/claude-accounts/profiles/wsl/claude-profile-wsl-router.ts', reason: WSL },
  { file: 'src/main/claude-accounts/runtime-auth-service.ts', reason: WSL },
  { file: 'src/main/codex/hooks/installation/codex-wsl-hook-install-plan.ts', reason: WSL },
  {
    file: 'src/main/codex-accounts/runtime-home/routing/runtime-home-service-home-routing.ts',
    reason: WSL
  },
  { file: 'src/main/kimi/hook-service.ts', line: 'remoteHome', reason: WSL },
  { file: 'src/main/kimi/hook-service.ts', line: 'const remoteScriptPath', reason: WSL },
  { file: 'src/main/kimi/kimi-runtime-home.ts', line: 'parseWslUncPath(home)', reason: WSL },
  {
    file: 'src/main/workspaces/removal/retirement/worktree-retirement-discovery.ts',
    line: 'distroHome',
    reason: WSL
  },
  { file: 'src/wsl-guest/plugins/overlays/claude-agent-view-plugin.ts', reason: WSL },
  { file: 'src/main/grok/grok-hook-remote-install.ts', reason: WSL },
  { file: 'src/main/copilot/copilot-remote-hook-install.ts', reason: WSL },
  { file: 'src/main/codex/hooks/installation/codex-hook-remote-install.ts', reason: WSL },
  { file: 'src/main/droid/hook-service.ts', line: 'remoteScriptPath', reason: WSL },
  { file: 'src/main/command-code/hook-service.ts', line: 'remoteScriptPath', reason: WSL },
  { file: 'src/main/antigravity/hook-service.ts', line: 'const remote', reason: WSL },
  {
    file: 'src/main/codex-accounts/managed-homes/codex-config-mirror.ts',
    line: 'wslHome',
    reason: WSL
  },
  {
    file: 'src/main/codex/trust/hooks/codex-hook-trust-cleanup.ts',
    line: 'linuxRuntimeHome',
    reason: WSL
  },
  {
    file: 'src/main/qwen-code/workspace-trust.ts',
    line: "join(env.QWEN_CLI_HOME, '.qwen')",
    reason: "Qwen 1.0's own folder variable from the launch env"
  },
  {
    file: 'src/main/ai-vault/discovery/session-scanner-agent-sources.ts',
    line: 'wslHomeDirs',
    reason: WSL
  },
  {
    file: 'src/main/ai-vault/scanners/hermes/session-scanner-hermes-sources.ts',
    line: 'wslHomeDirs',
    reason: WSL
  },
  {
    file: 'src/main/ai-vault/scanners/openclaw/openclaw-session-layout.ts',
    line: 'wslHomeDirs',
    reason: WSL
  },
  {
    file: 'src/main/skills/discovery/skill-discovery-sources.ts',
    line: "'.hermes', 'skills'",
    reason: WSL
  },
  {
    file: 'src/main/skills/discovery/claude-plugin-skill-sources.ts',
    line: ": pathApi.join(homeDir, '.claude')",
    reason: WSL
  },
  {
    file: 'src/main/skills/discovery/skill-discovery-sources.ts',
    line: 'antigravity-cli',
    reason: ANTIGRAVITY
  },
  {
    file: 'src/main/agent-launch/trust/agent-trust-presets.ts',
    line: 'antigravity-cli',
    reason: ANTIGRAVITY
  },
  {
    file: 'src/main/ai-vault/scanners/antigravity/session-scanner-antigravity-sources.ts',
    reason: ANTIGRAVITY
  },
  {
    file: 'src/main/antigravity/agy-credential-presence.ts',
    line: 'antigravity-cli',
    reason: "read only: a stat of agy's token file; agy has no folder variable"
  },
  {
    file: 'src/main/avatar-generation/avatar-image-agent-run.ts',
    line: 'antigravity-cli',
    reason: 'the files of the run that Orca started; agy has no folder variable, so it writes there'
  },
  { file: 'src/main/antigravity/antigravity-chat-user-skills.ts', reason: ANTIGRAVITY },
  { file: 'src/main/antigravity/antigravity-host-acp.ts', reason: ANTIGRAVITY },
  { file: 'src/main/antigravity/antigravity-transcript-import.ts', reason: ANTIGRAVITY },
  { file: 'src/main/antigravity/hook-service.ts', reason: ANTIGRAVITY },
  { file: 'src/main/antigravity/native-credential-backend.ts', reason: ANTIGRAVITY },
  { file: 'src/main/antigravity/native-windows-credentials.ts', reason: ANTIGRAVITY },
  {
    file: 'src/main/codex-accounts/account-management/service-test-harness.ts',
    reason: 'a test harness with its own fake home'
  },
  {
    file: 'src/main/codex-accounts/runtime-home/runtime-home-service-test-harness.ts',
    reason: 'a test harness with its own fake home'
  },
  {
    file: 'src/main/kimi/kimi-acp-launch-spec.ts',
    line: 'installDirectories',
    reason: "a managed account's own home"
  },
  {
    file: 'src/main/mimo/mimo-acp-launch-spec.ts',
    line: "'.mimocode', 'bin'",
    reason: 'the mimo binary folder, not its config'
  },
  {
    file: 'src/main/startup/configure-process.ts',
    line: '.grok/bin',
    reason: 'the grok binary folder'
  },
  {
    file: 'src/shared/shell/command-resolution/system-cli-install-dirs.ts',
    reason: 'agent binary folders, not config'
  },
  {
    file: 'src/shared/shell/command-resolution/posix-version-manager-bin-dirs.ts',
    reason: 'the grok binary folder on PATH, not its config'
  },
  {
    file: 'src/main/bots/bot-import-sources.ts',
    line: "join(input.home, '.hermes')",
    reason: 'the line before reads HERMES_HOME'
  },
  {
    file: 'src/main/workspaces/removal/retirement/worktree-retirement-discovery.ts',
    line: 'override ?',
    reason: 'override is CLAUDE_CONFIG_DIR'
  },
  {
    file: 'src/main/claude-accounts/profiles/setup/claude-profile-provisioning.ts',
    line: 'const imported = resolve(defaultHome)',
    reason: 'compares only; defaultHome reads CLAUDE_CONFIG_DIR'
  },
  {
    file: 'src/main/claude-accounts/profiles/claude-profile-paths.ts',
    reason: "userConfigDir reads CLAUDE_CONFIG_DIR, the profile's, before the default"
  },
  {
    file: 'src/main/codex-cli/codex-home-process-lock.ts',
    line: "codexHome ?? join(homedir(), '.codex')",
    reason: 'a child env without CODEX_HOME runs Codex in the real home'
  },
  {
    file: 'src/main/bots/bot-home.ts',
    reason: "the default profile's bots folder; a profile keeps its bots in its userData"
  }
]

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return name === 'node_modules' || name === 'testing' ? [] : productionFiles(path)
    }
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.(test|spec)\.|fixture/.test(name)
      ? [path]
      : []
  })
}

describe('paths into the home folder', () => {
  it('go through the app profile helpers', () => {
    const raw: string[] = []
    for (const file of productionFiles(join(ROOT, 'src'))) {
      const path = relative(ROOT, file).split(sep).join('/')
      const text = readFileSync(file, 'utf8')
      for (const pattern of RAW_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const line = text.slice(
            text.lastIndexOf('\n', match.index) + 1,
            text.indexOf('\n', match.index + match[0].length)
          )
          const variable = FOLDER_VARIABLE[match[1]]
          if (variable && line.includes(variable)) {
            continue
          }
          if (
            ALLOWED.some(
              (entry) => entry.file === path && (!entry.line || line.includes(entry.line))
            )
          ) {
            continue
          }
          raw.push(`${path}: ${line.trim()}`)
        }
      }
    }
    expect(raw).toEqual([])
  })

  it('are not built when a module loads, before the profile folders are set', () => {
    const helpers = new Set([
      'defaultAgentHomeDir',
      'orcaHomeDir',
      'defaultClaudeJsonPath',
      'agentHomeDirIn'
    ])
    const atLoad: string[] = []
    for (const file of productionFiles(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('app-profile-homes')) {
        continue
      }
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node, inFunction: boolean): void => {
        const enters =
          ts.isFunctionLike(node) ||
          (ts.isPropertyDeclaration(node) &&
            !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
        if (
          !inFunction &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          helpers.has(node.expression.text)
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart())
          atLoad.push(`${relative(ROOT, file)}:${line + 1}: ${node.getText().slice(0, 80)}`)
        }
        ts.forEachChild(node, (child) => visit(child, inFunction || enters))
      }
      visit(source, false)
    }
    expect(atLoad).toEqual([])
  })
})
