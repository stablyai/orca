/** The small yellow dot that marks something waiting on the owner; never a tinted row. */
export function AttentionDot(): React.JSX.Element {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-warning" />
}
