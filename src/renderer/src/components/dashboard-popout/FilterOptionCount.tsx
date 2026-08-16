/** Right-aligned tally on a filter menu row. */
export function FilterOptionCount({ count }: { count: number }): React.JSX.Element {
  return <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{count}</span>
}
