// Why: MantisBT has no `categoryKey` concept like Jira's status categories —
// custom installs can reorder/rename the enum, but a fresh install's default
// numeric ids are fixed (10 new .. 90 closed), so this switches on ranges of
// that default enum rather than a fetched per-site category.
export function getMantisBTStatusTone(statusId: string): string {
  const id = Number(statusId)
  if (id >= 80) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (id >= 30) {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}
