import type { TuiAgent } from './tui-agent'

/**
 * Agents Orca can place an installed skill for.
 *
 * `null` segments mean the agent reads the canonical `.agents/skills` root at
 * that scope, so it needs no placement of its own. Ids are Orca agent ids so a
 * detected agent maps straight to a destination.
 */
type SkillInstallProviderEntry = {
  id: TuiAgent
  displayName: string
  globalSegments: readonly string[] | null
  workspaceSegments: readonly string[] | null
  /** Env var relocating the agent's home (skills in `<home>/skills`). */
  homeEnv?: string
}

export const SKILL_INSTALL_PROVIDERS = Object.freeze([
  // Why: Codex reads the canonical .agents/skills root at both scopes.
  {
    id: 'codex',
    displayName: 'Codex',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    globalSegments: ['.claude', 'skills'],
    workspaceSegments: ['.claude', 'skills'],
    homeEnv: 'CLAUDE_CONFIG_DIR'
  },
  // Why: Cursor and Gemini read the canonical root inside a project but keep
  // their own home directory, so they only need a placement at global scope.
  {
    id: 'cursor',
    displayName: 'Cursor',
    globalSegments: ['.cursor', 'skills'],
    workspaceSegments: null
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    globalSegments: ['.gemini', 'skills'],
    workspaceSegments: null
  },
  {
    id: 'droid',
    displayName: 'Droid',
    globalSegments: ['.factory', 'skills'],
    workspaceSegments: ['.factory', 'skills']
  },
  {
    id: 'continue',
    displayName: 'Continue',
    globalSegments: ['.continue', 'skills'],
    workspaceSegments: ['.continue', 'skills']
  },
  {
    id: 'trae',
    displayName: 'Trae',
    globalSegments: ['.trae-cn', 'skills'],
    workspaceSegments: ['.trae', 'skills']
  },
  {
    id: 'grok',
    displayName: 'Grok',
    globalSegments: ['.grok', 'skills'],
    workspaceSegments: ['.grok', 'skills'],
    homeEnv: 'GROK_HOME'
  },
  {
    id: 'aug',
    displayName: 'Augment',
    globalSegments: ['.augment', 'skills'],
    workspaceSegments: ['.augment', 'skills']
  },
  // Why: Muse reads the canonical .agents/skills root at both scopes.
  {
    id: 'muse',
    displayName: 'Muse',
    globalSegments: null,
    workspaceSegments: null
  },
  // Why: ZCode loads user skills from `~/.zcode/skills`; project skills come from the
  // canonical `.agents/skills` root the shared repo source already covers.
  {
    id: 'zcode',
    displayName: 'ZCode',
    globalSegments: ['.zcode', 'skills'],
    workspaceSegments: null
  },
  {
    id: 'codebuddy',
    displayName: 'CodeBuddy',
    globalSegments: ['.codebuddy', 'skills'],
    workspaceSegments: ['.codebuddy', 'skills']
  },
  {
    id: 'kiro',
    displayName: 'Kiro',
    globalSegments: ['.kiro', 'skills'],
    workspaceSegments: ['.kiro', 'skills'],
    homeEnv: 'KIRO_HOME'
  },
  // Why: the Antigravity CLI keeps user skills under its config home and
  // project skills in the canonical root.
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    globalSegments: ['.gemini', 'config', 'skills'],
    workspaceSegments: null
  },
  // Why: OpenClaude keeps its own `.openclaude` home; it does not read Claude's folders by default.
  {
    id: 'openclaude',
    displayName: 'OpenClaude',
    globalSegments: ['.openclaude', 'skills'],
    workspaceSegments: ['.openclaude', 'skills'],
    homeEnv: 'OPENCLAUDE_CONFIG_DIR'
  },
  // Why: every agent below reads the canonical .agents/skills root at both scopes.
  {
    id: 'autohand',
    displayName: 'Autohand Code',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'goose',
    displayName: 'Goose',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'crush',
    displayName: 'Crush',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'command-code',
    displayName: 'Command Code',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'mistral-vibe',
    displayName: 'Mistral Vibe',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'rovo',
    displayName: 'Rovo Dev',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'openclaw',
    displayName: 'OpenClaw',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'devin',
    displayName: 'Devin',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'pi',
    displayName: 'Pi',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'amp',
    displayName: 'Amp',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'kilo',
    displayName: 'Kilo Code',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'cline',
    displayName: 'Cline',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'kimi',
    displayName: 'Kimi',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'opencode2',
    displayName: 'OpenCode 2',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'mimo-code',
    displayName: 'MiMo Code',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'omp',
    displayName: 'OMP',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'prime-agent',
    displayName: 'Prime Agent',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'qoder',
    displayName: 'Qoder',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'qoder-cn',
    displayName: 'Qoder CN',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'codebuff',
    displayName: 'Codebuff',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'freebuff',
    displayName: 'Freebuff',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'ante',
    displayName: 'Ante',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'jcode',
    displayName: 'Jcode',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    globalSegments: null,
    workspaceSegments: null
  }
] satisfies SkillInstallProviderEntry[])

export type SkillInstallProviderDefinition = (typeof SKILL_INSTALL_PROVIDERS)[number]
export type SkillInstallProviderId = SkillInstallProviderDefinition['id']

export function isSkillInstallProviderId(value: string): value is SkillInstallProviderId {
  return SKILL_INSTALL_PROVIDERS.some((provider) => provider.id === value)
}

/**
 * An explicit choice is authoritative, including agents the target may install
 * later. Removal passes no choice so it can clean every previously used root.
 */
export function selectedOrDetectedSkillProviders(
  detectedProviders: readonly string[],
  selectedProviders: readonly string[] | undefined
): readonly string[] {
  return selectedProviders ?? detectedProviders
}
