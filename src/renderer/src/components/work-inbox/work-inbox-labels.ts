import type { WorkInboxItem } from '../../../../shared/work-inbox'
export type WorkInboxFilterOption = { id: string; label: string }
/** Per-host facts that outlive one view or filter: filter labels and the unfiltered open count. */
export type KnownLabels = {
  targetKey: string
  projects: Map<string, string>
  agents: Map<string, string>
  openCount: number | null
}

export function rememberLabels(
  known: KnownLabels,
  items: readonly WorkInboxItem[],
  openCount: number
): KnownLabels {
  const projects = new Map(known.projects)
  const agents = new Map(known.agents)
  for (const item of items) {
    if (item.projectId) {
      projects.set(item.projectId, item.projectLabel ?? item.projectId)
    }
    agents.set(item.agentId, item.agentLabel)
  }
  return { targetKey: known.targetKey, projects, agents, openCount }
}

export function sortedOptions(labels: Map<string, string>): WorkInboxFilterOption[] {
  return [...labels]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
