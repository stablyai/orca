import type { ShortcutWorkflowStateType } from '../../../shared/shortcut-types'

export function getShortcutStateTone(stateType: ShortcutWorkflowStateType): string {
  if (stateType === 'done') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (stateType === 'started') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}
