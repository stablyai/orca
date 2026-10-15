import type { PluginTaskStatusTone } from '../../../../../shared/plugins/plugin-task-source'

const TONE_CLASSES: Record<PluginTaskStatusTone, string> = {
  open: 'border-border/50 bg-muted/40 text-muted-foreground',
  active: 'border-status-warning-border bg-status-warning-background text-status-warning',
  blocked: 'border-destructive/30 bg-destructive/10 text-destructive',
  review: 'border-foreground/30 bg-accent text-foreground',
  done: 'border-status-success-border bg-status-success-background text-status-success',
  closed: 'border-border/40 bg-transparent text-muted-foreground'
}

export function getPluginTaskStatusTone(tone: PluginTaskStatusTone | undefined): string {
  return TONE_CLASSES[tone ?? 'open']
}
