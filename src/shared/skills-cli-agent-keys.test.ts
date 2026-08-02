import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT,
  isSkillsCliAgentKeyShaped,
  SKILLS_CLI_UNIVERSAL_AGENT_KEY,
  toSkillsCliAgentKeys
} from './skills-cli-agent-keys'

// Why: the community `skills` CLI validates --agent against this namespace and
// exits 1 on anything else, so a typo here breaks installs outright. Captured
// from `skills add --agent <invalid>`, which prints its own valid list (v1.5.20).
const SKILLS_CLI_VALID_AGENT_KEYS = new Set([
  'aider-desk',
  'amp',
  'antigravity',
  'antigravity-cli',
  'astrbot',
  'autohand-code',
  'augment',
  'bob',
  'claude-code',
  'openclaw',
  'cline',
  'codearts-agent',
  'codebuddy',
  'codemaker',
  'codestudio',
  'codex',
  'command-code',
  'continue',
  'cortex',
  'crush',
  'cursor',
  'deepagents',
  'devin',
  'dexto',
  'droid',
  'eve',
  'firebender',
  'forgecode',
  'gemini-cli',
  'github-copilot',
  'goose',
  'grok',
  'hermes-agent',
  'inference-sh',
  'jazz',
  'junie',
  'iflow-cli',
  'kilo',
  'kimchi',
  'kimi-code-cli',
  'kiro-cli',
  'kode',
  'lingma',
  'loaf',
  'mcpjam',
  'mistral-vibe',
  'moxby',
  'mux',
  'opencode',
  'openhands',
  'ona',
  'pi',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'replit',
  'reasonix',
  'rovodev',
  'roo',
  'tabnine-cli',
  'terramind',
  'tinycloud',
  'trae',
  'trae-cn',
  'warp',
  'windsurf',
  'zed',
  'zcode',
  'zencoder',
  'zenflow',
  'neovate',
  'pochi',
  'promptscript',
  'adal',
  'universal'
])

describe('skills CLI agent keys', () => {
  it('only maps onto keys the skills CLI accepts', () => {
    for (const [agent, key] of Object.entries(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT)) {
      if (key !== null) {
        expect(SKILLS_CLI_VALID_AGENT_KEYS, `${agent} -> ${key}`).toContain(key)
      }
    }
    expect(SKILLS_CLI_VALID_AGENT_KEYS).toContain(SKILLS_CLI_UNIVERSAL_AGENT_KEY)
  })

  it('covers every agent Orca can detect', () => {
    // Why: a new TuiAgent must be considered here, even if the answer is null —
    // otherwise it silently falls back to universal-only with no decision made.
    expect(Object.keys(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT).sort()).toEqual(
      Object.keys(TUI_AGENT_CONFIG).sort()
    )
  })

  it("follows Orca's own evidence for the two non-obvious mappings", () => {
    // Why: src/shared/native-chat-agent-profiles.ts states OpenClaude reads
    // Claude-owned roots, so it is not unmappable.
    expect(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT.openclaude).toBe('claude-code')
    // Why: Orca detects trae via `traecli`, which tui-agent-config calls an alias
    // only TRAE CN ships, so the CN directory is the right target.
    expect(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT.trae).toBe('trae-cn')
  })

  it('rejects values the skills CLI would drop, and allows the explicit wildcard', () => {
    for (const bad of ['-y', '--copy', '', ' ', 'a b', 'a,b']) {
      expect(isSkillsCliAgentKeyShaped(bad), bad).toBe(false)
    }
    for (const good of ['claude-code', 'universal', 'trae-cn', 'inference-sh', '*']) {
      expect(isSkillsCliAgentKeyShaped(good), good).toBe(true)
    }
  })

  it('always includes the shared directory and drops unmappable agents', () => {
    expect(toSkillsCliAgentKeys(['claude', 'rovo'])).toEqual([
      'claude-code',
      'rovodev',
      'universal'
    ])
    // Why: `omp` has no skills-CLI equivalent, so it must not reach the argv.
    expect(toSkillsCliAgentKeys(['omp'])).toEqual(['universal'])
    expect(toSkillsCliAgentKeys([])).toEqual(['universal'])
  })
})
