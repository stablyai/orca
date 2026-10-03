export function getJiraStatusTone(categoryKey: string): string {
  if (categoryKey === 'done') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (categoryKey === 'indeterminate') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}

// Why: mirror Jira's own priority palette so the list scans the way the board does.
export function getJiraPriorityTone(priorityName: string | undefined): string {
  switch (priorityName?.toLowerCase()) {
    case 'highest':
    case 'blocker':
    case 'critical':
      return 'font-semibold text-red-700 dark:text-red-400'
    case 'high':
    case 'major':
      return 'text-red-500 dark:text-red-300'
    case 'medium':
    case 'normal':
      return 'text-yellow-600 dark:text-yellow-400'
    case 'low':
    case 'minor':
      return 'text-blue-600 dark:text-blue-400'
    case 'lowest':
    case 'trivial':
      return 'text-sky-500 dark:text-sky-300'
    case undefined:
    default:
      return 'text-muted-foreground'
  }
}
