import type {
  AgentContextInstructionFile,
  AgentContextReport,
  AgentContextScope
} from '../../../../shared/agent-context'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { DiscoveredSkill } from '../../../../shared/skills'
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

function normalizePathForPrefix(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
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
