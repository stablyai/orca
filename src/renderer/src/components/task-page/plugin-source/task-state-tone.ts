import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'

type PluginTaskStateCategory = PluginTaskItem['state']['category']

/** Tones the contributed state badge by category, never by name: a provider's
 *  state names are its own vocabulary, the four categories are the contract. */
export function getPluginTaskStateTone(category: PluginTaskStateCategory): string {
  if (category === 'done') {
    return 'border-border/50 bg-muted/40 text-workspace-status-done'
  }
  if (category === 'in-progress') {
    return 'border-border/50 bg-muted/40 text-workspace-status-progress'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}
