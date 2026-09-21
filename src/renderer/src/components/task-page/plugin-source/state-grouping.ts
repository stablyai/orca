import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'

type PluginTaskStateCategory = PluginTaskItem['state']['category']

export type PluginTaskStateSection = {
  key: string
  label: string
  category: PluginTaskStateCategory
  items: PluginTaskItem[]
}

const CATEGORY_RANK: Record<PluginTaskStateCategory, number> = {
  todo: 0,
  'in-progress': 1,
  done: 2,
  unknown: 3
}

/** Groups by state name, ordered by category so a board reads left-to-right the
 *  way its workflow runs, whatever the provider calls each state. */
export function groupPluginTaskItemsByState(
  items: readonly PluginTaskItem[]
): PluginTaskStateSection[] {
  const sections = new Map<string, PluginTaskStateSection>()
  for (const item of items) {
    const key = `state:${item.state.name}`
    const section = sections.get(key)
    if (section) {
      section.items.push(item)
    } else {
      sections.set(key, {
        key,
        label: item.state.name,
        category: item.state.category,
        items: [item]
      })
    }
  }
  return [...sections.values()].sort((a, b) => {
    const rankA = CATEGORY_RANK[a.category]
    const rankB = CATEGORY_RANK[b.category]
    return rankA === rankB ? a.label.localeCompare(b.label) : rankA - rankB
  })
}
