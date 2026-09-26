export function getBusinessmapCardStatusTone(columnName: string, isDone: boolean): string {
  if (isDone) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (/progress|doing|work/i.test(columnName)) {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}

export function isBusinessmapCardDone(columnName: string): boolean {
  return /^(done|complete|completed|closed|archive)/i.test(columnName.trim())
}
