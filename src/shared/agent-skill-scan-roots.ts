import { basename, join, type posix } from 'node:path'
import { createHash } from 'node:crypto'
import type { SkillDiscoverySource, SkillProvider, SkillSourceKind } from './skills'
import type { AgentType } from './agent-status-types'
import type { SkillInstallProviderId } from './skill-install-providers'

/**
 * Where an agent looks for skills, as plain path arithmetic.
 *
 * Shared rather than main-owned because the `orca` CLI has to judge the same roots the
 * app does before it spawns `npx skills update` (see `skill-linked-root-deletion.ts`),
 * and a second copy of this table would drift. Everything that needs the host — env
 * overrides, the Hermes profile probe, WSL — stays in `main/skills`, which resolves
 * those and passes the answers in.
 */
export type AgentSkillScanRoot = Omit<SkillDiscoverySource, 'exists' | 'skippedReason'>

export type AgentSkillProviderRootOverrides = Partial<Record<SkillInstallProviderId, string>>

export type AgentSkillScanPathApi = Pick<typeof posix, 'basename' | 'join'>

/** The root that holds the content every provider root links at. */
export const CANONICAL_AGENT_SKILLS_ROOT_ID = 'home-agents'

export function stableSkillPathId(pathValue: string): string {
  return createHash('sha1').update(pathValue).digest('hex').slice(0, 16)
}

function source(
  id: string,
  label: string,
  path: string,
  sourceKind: SkillSourceKind,
  providers: SkillProvider[],
  owner: AgentType | null
): AgentSkillScanRoot {
  return { id, label, path, sourceKind, providers, owner }
}

export function buildAgentSkillHomeRoots(args: {
  home: string
  hermesSkillsRoot: string
  pathApi?: AgentSkillScanPathApi
  providerRootOverrides?: AgentSkillProviderRootOverrides
}): AgentSkillScanRoot[] {
  const pathApi = args.pathApi ?? { basename, join }
  const home = args.home
  const providerRootOverrides = args.providerRootOverrides ?? {}
  return [
    source(
      'home-codex',
      'Codex home',
      pathApi.join(home, '.codex', 'skills'),
      'home',
      ['codex'],
      'codex'
    ),
    source(
      CANONICAL_AGENT_SKILLS_ROOT_ID,
      'Agent skills home',
      pathApi.join(home, '.agents', 'skills'),
      'home',
      ['agent-skills'],
      null
    ),
    source(
      'home-claude',
      'Claude home',
      providerRootOverrides.claude ?? pathApi.join(home, '.claude', 'skills'),
      'home',
      ['claude'],
      'claude'
    ),
    source(
      'codex-plugin-cache',
      'Codex plugin cache',
      pathApi.join(home, '.codex', 'plugins', 'cache'),
      'plugin',
      ['codex', 'agent-skills'],
      'codex'
    ),
    // Why: `npx skills add --global` writes into each agent's own home skills
    // directory, so coverage misses them unless we scan every provider root.
    source(
      'home-grok',
      'Grok home',
      providerRootOverrides.grok ?? pathApi.join(home, '.grok', 'skills'),
      'home',
      ['agent-skills'],
      'grok'
    ),
    source(
      'home-opencode',
      'OpenCode home',
      pathApi.join(home, '.config', 'opencode', 'skills'),
      'home',
      ['agent-skills'],
      'opencode'
    ),
    source(
      'home-pi',
      'Pi home',
      pathApi.join(home, '.pi', 'agent', 'skills'),
      'home',
      ['agent-skills'],
      'pi'
    ),
    source(
      'home-omp',
      'OMP home',
      pathApi.join(home, '.omp', 'agent', 'skills'),
      'home',
      ['agent-skills'],
      'omp'
    ),
    source('home-hermes', 'Hermes home', args.hermesSkillsRoot, 'home', ['agent-skills'], 'hermes'),
    source(
      'home-prime-agent',
      'Prime Agent home',
      pathApi.join(home, '.prime', 'agent', 'skills'),
      'home',
      ['agent-skills'],
      'prime-agent'
    ),
    source(
      'home-gemini',
      'Gemini home',
      pathApi.join(home, '.gemini', 'skills'),
      'home',
      ['agent-skills'],
      'gemini'
    ),
    source(
      'home-antigravity',
      'Antigravity home',
      pathApi.join(home, '.gemini', 'antigravity', 'skills'),
      'home',
      ['agent-skills'],
      'antigravity'
    ),
    source(
      'home-cursor',
      'Cursor home',
      pathApi.join(home, '.cursor', 'skills'),
      'home',
      ['agent-skills'],
      'cursor'
    ),
    source(
      'home-droid',
      'Droid home',
      pathApi.join(home, '.factory', 'skills'),
      'home',
      ['agent-skills'],
      'droid'
    ),
    source(
      'home-continue',
      'Continue home',
      pathApi.join(home, '.continue', 'skills'),
      'home',
      ['agent-skills'],
      'continue'
    ),
    source(
      'home-trae',
      'Trae home',
      pathApi.join(home, '.trae-cn', 'skills'),
      'home',
      ['agent-skills'],
      'trae'
    ),
    source(
      'home-aug',
      'Augment home',
      pathApi.join(home, '.augment', 'skills'),
      'home',
      ['agent-skills'],
      'aug'
    ),
    // Why: user skills live under XDG config home (`~/.config/muse/skills` by
    // default); project skills are the canonical `.agents/skills` root already
    // covered by home-agents/repo-agents, so no agent-specific repo source.
    source(
      'home-muse',
      'Muse home',
      pathApi.join(home, '.config', 'muse', 'skills'),
      'home',
      ['agent-skills'],
      'muse'
    ),
    // Why: ZCode loads user skills from `~/.zcode/skills`; project skills are the canonical
    // `.agents/skills` root already covered by home-agents/repo-agents.
    source(
      'home-zcode',
      'ZCode home',
      pathApi.join(home, '.zcode', 'skills'),
      'home',
      ['agent-skills'],
      'zcode'
    )
  ]
}

export function buildAgentSkillRepoRoots(
  repoPath: string,
  pathApi: AgentSkillScanPathApi = { basename, join }
): AgentSkillScanRoot[] {
  const label = `Repo ${pathApi.basename(repoPath)}`
  const id = stableSkillPathId(repoPath)
  return [
    source(
      `repo-agents-${id}`,
      `${label} .agents`,
      pathApi.join(repoPath, '.agents', 'skills'),
      'repo',
      ['agent-skills'],
      null
    ),
    source(
      `repo-claude-${id}`,
      `${label} .claude`,
      pathApi.join(repoPath, '.claude', 'skills'),
      'repo',
      ['claude'],
      'claude'
    ),
    source(
      `repo-droid-${id}`,
      `${label} .factory`,
      pathApi.join(repoPath, '.factory', 'skills'),
      'repo',
      ['agent-skills'],
      'droid'
    ),
    source(
      `repo-continue-${id}`,
      `${label} .continue`,
      pathApi.join(repoPath, '.continue', 'skills'),
      'repo',
      ['agent-skills'],
      'continue'
    ),
    source(
      `repo-trae-${id}`,
      `${label} .trae`,
      pathApi.join(repoPath, '.trae', 'skills'),
      'repo',
      ['agent-skills'],
      'trae'
    ),
    source(
      `repo-grok-${id}`,
      `${label} .grok`,
      pathApi.join(repoPath, '.grok', 'skills'),
      'repo',
      ['agent-skills'],
      'grok'
    ),
    source(
      `repo-aug-${id}`,
      `${label} .augment`,
      pathApi.join(repoPath, '.augment', 'skills'),
      'repo',
      ['agent-skills'],
      'aug'
    )
  ]
}
