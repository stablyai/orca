import type {
  AgentContextInstructionFile,
  AgentContextReport,
  AgentContextScope
} from '../../../../shared/agent-context'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../../shared/skills'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function agentDisplayName(agent: AgentType): string {
  return TUI_AGENT_DISPLAY_NAMES[agent as TuiAgent] ?? agent
}

export const SCOPE_ORDER: Record<AgentContextScope, number> = { project: 0, ancestor: 1, home: 2 }

export function sortByScope<T extends { scope: AgentContextScope }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])
}

export function formatBytes(sizeBytes: number | null): string {
  if (sizeBytes === null) {
    return ''
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`
  }
  const kib = sizeBytes / 1024
  return kib < 100 ? `${kib.toFixed(1)} KB` : `${Math.round(kib)} KB`
}

const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/])/

/** Windows drive and UNC paths compare case-insensitively; POSIX paths keep case. */
function normalizePathForPrefix(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/').replace(/\/+$/, '')
  return WINDOWS_PATH_PATTERN.test(pathValue) ? normalized.toLowerCase() : normalized
}

/** Whether `child` is `parent` or sits inside it, tolerant of separator style. */
export function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = normalizePathForPrefix(child)
  const normalizedParent = normalizePathForPrefix(parent)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
}

/**
 * Discovery scans every locally registered repo's skill roots; the panel keeps
 * global roots plus repo roots that belong to this workspace only.
 */
export function selectWorkspaceSkills(
  skills: readonly DiscoveredSkill[],
  workspaceCwd: string | null
): DiscoveredSkill[] {
  return skills.filter((skill) => {
    if (skill.sourceKind !== 'repo') {
      return true
    }
    if (!workspaceCwd) {
      return false
    }
    const roots = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
    return roots.some((root) => isPathInside(root, workspaceCwd))
  })
}

export type InstructionFileGroup = {
  scope: AgentContextScope
  files: AgentContextInstructionFile[]
}

export function groupInstructionFiles(
  files: readonly AgentContextInstructionFile[],
  showMissing: boolean
): InstructionFileGroup[] {
  const groups = new Map<AgentContextScope, AgentContextInstructionFile[]>()
  for (const file of sortByScope(files)) {
    if (!file.exists && !showMissing) {
      continue
    }
    const bucket = groups.get(file.scope) ?? []
    bucket.push(file)
    groups.set(file.scope, bucket)
  }
  return [...groups.entries()].map(([scope, groupFiles]) => ({ scope, files: groupFiles }))
}

export function countPresent(report: AgentContextReport | null): {
  instructionFiles: number
  mcpServers: number
  hooks: number
  plugins: number
} {
  if (!report) {
    return { instructionFiles: 0, mcpServers: 0, hooks: 0, plugins: 0 }
  }
  return {
    instructionFiles: report.instructionFiles.filter((file) => file.exists).length,
    mcpServers: report.mcpFiles.reduce((sum, file) => sum + file.inspection.servers.length, 0),
    hooks: report.hookFiles.reduce((sum, file) => sum + file.hookCount, 0),
    plugins: report.plugins.filter((plugin) => plugin.enabled).length
  }
}

export type SkillSourceGroup = { label: string; skills: DiscoveredSkill[] }

const SKILL_SOURCE_KIND_ORDER: Record<DiscoveredSkill['sourceKind'], number> = {
  repo: 0,
  home: 1,
  plugin: 2,
  bundled: 3
}

/** Workspace-local skills first, then per-agent homes, then plugin caches. */
export function groupSkillsBySource(skills: readonly DiscoveredSkill[]): SkillSourceGroup[] {
  const groups = new Map<
    string,
    { kind: DiscoveredSkill['sourceKind']; skills: DiscoveredSkill[] }
  >()
  for (const skill of skills) {
    const bucket = groups.get(skill.sourceLabel) ?? { kind: skill.sourceKind, skills: [] }
    bucket.skills.push(skill)
    groups.set(skill.sourceLabel, bucket)
  }
  return [...groups.entries()]
    .sort(
      ([labelA, a], [labelB, b]) =>
        SKILL_SOURCE_KIND_ORDER[a.kind] - SKILL_SOURCE_KIND_ORDER[b.kind] ||
        labelA.localeCompare(labelB)
    )
    .map(([label, bucket]) => ({
      label,
      skills: [...bucket.skills].sort((a, b) => a.name.localeCompare(b.name))
    }))
}

/** Which agent owns each discovered skill root; `null` marks a shared root every agent reads. */
export function skillRootOwners(
  sources: readonly SkillDiscoverySource[]
): Map<string, AgentType | null> {
  return new Map(sources.map((source) => [source.path, source.owner]))
}

function skillBelongsToAgent(
  skill: DiscoveredSkill,
  agent: AgentType,
  owners: Map<string, AgentType | null>
): boolean {
  const roots = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
  return roots.some((root) => {
    const owner = owners.get(root)
    // Why: a root discovery did not enumerate (e.g. a plugin root) falls back
    // to the skill's providers, where `agent-skills` means every agent.
    if (owner === undefined) {
      return skill.providers.includes(agent as never) || skill.providers.includes('agent-skills')
    }
    return owner === null || owner === agent
  })
}

export function selectSkillsForAgents(
  skills: readonly DiscoveredSkill[],
  sources: readonly SkillDiscoverySource[],
  agents: readonly AgentType[] | null
): DiscoveredSkill[] {
  if (!agents) {
    return [...skills]
  }
  const owners = skillRootOwners(sources)
  return skills.filter((skill) => agents.some((agent) => skillBelongsToAgent(skill, agent, owners)))
}

type ReportRow = { agents: AgentType[]; scope: AgentContextScope }

/** Every row of every kind, in one list, for filters and rollups that treat them alike. */
function reportRows(report: AgentContextReport | null): ReportRow[] {
  if (!report) {
    return []
  }
  return [...report.instructionFiles, ...report.mcpFiles, ...report.hookFiles, ...report.plugins]
}

function filterReportRows(
  report: AgentContextReport,
  keep: (row: ReportRow) => boolean
): AgentContextReport {
  return {
    ...report,
    instructionFiles: report.instructionFiles.filter(keep),
    mcpFiles: report.mcpFiles.filter(keep),
    hookFiles: report.hookFiles.filter(keep),
    plugins: report.plugins.filter(keep)
  }
}

/** The report narrowed to rows any of the given agents reads; `null` returns it unchanged. */
export function filterReportByAgents(
  report: AgentContextReport | null,
  agents: readonly AgentType[] | null
): AgentContextReport | null {
  if (!report || !agents) {
    return report
  }
  return filterReportRows(report, (row) => row.agents.some((agent) => agents.includes(agent)))
}

/** Where a row comes from: the workspace tree (and its parents) or the user's home. */
export type ContextScopeFilter = 'workspace' | 'user' | 'all'

function scopeMatches(scope: AgentContextScope, filter: ContextScopeFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'user':
      return scope === 'home'
    default:
      return scope === 'project' || scope === 'ancestor'
  }
}

export function filterReportByScope(
  report: AgentContextReport | null,
  filter: ContextScopeFilter
): AgentContextReport | null {
  if (!report || filter === 'all') {
    return report
  }
  return filterReportRows(report, (row) => scopeMatches(row.scope, filter))
}

/** Repo skills belong to the workspace; home, plugin and bundled skills belong to the user. */
export function selectSkillsForScope(
  skills: readonly DiscoveredSkill[],
  filter: ContextScopeFilter
): DiscoveredSkill[] {
  if (filter === 'all') {
    return [...skills]
  }
  const wantRepo = filter === 'workspace'
  return skills.filter((skill) => (skill.sourceKind === 'repo') === wantRepo)
}

/** Every agent that reads at least one row or owns at least one skill root here. */
export function agentsInContext(
  report: AgentContextReport | null,
  skills: readonly DiscoveredSkill[],
  sources: readonly SkillDiscoverySource[]
): AgentType[] {
  const agents = new Set<AgentType>()
  for (const row of reportRows(report)) {
    for (const agent of row.agents) {
      agents.add(agent)
    }
  }
  const owners = skillRootOwners(sources)
  for (const skill of skills) {
    const roots = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
    for (const root of roots) {
      const owner = owners.get(root)
      if (owner) {
        agents.add(owner)
      }
    }
  }
  return [...agents]
}
