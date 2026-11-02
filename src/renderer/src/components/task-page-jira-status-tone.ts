export function getJiraStatusTone(categoryKey: string): string {
  if (categoryKey === 'done') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (categoryKey === 'indeterminate') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}

export function getJiraPriorityTone(priorityName: string | undefined): string {
  switch (priorityName?.toLowerCase()) {
    case 'highest':
    case 'blocker':
    case 'critical':
    case 'high':
    case 'major':
      return 'text-jira-priority-high'
    case 'medium':
    case 'normal':
      return 'text-jira-priority-medium'
    case 'low':
    case 'minor':
    case 'lowest':
    case 'trivial':
      return 'text-jira-priority-low'
    case undefined:
    default:
      return 'text-muted-foreground'
  }
}
