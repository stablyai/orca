/** Same look as DropdownMenuShortcut, so the landing reads like the + menu it mirrors. */
export function LandingItemShortcut({ label }: { label: string | null }): React.JSX.Element | null {
  if (!label) {
    return null
  }
  return <span className="ml-auto text-xs tracking-widest text-muted-foreground">{label}</span>
}

export function landingQueryMatches(label: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || label.toLowerCase().includes(needle)
}
