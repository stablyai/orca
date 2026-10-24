/** Placeholder rows with the real row geometry, so the list doesn't jump when data lands. */
export function PluginListSkeleton({ rows }: { rows: number }): React.JSX.Element {
  return (
    <ul className="list-none" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li
          key={index}
          className="flex min-h-15 items-center gap-3 border-t border-border py-2.5 pr-3 pl-4 first:border-t-0"
        >
          <span className="size-8 shrink-0 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="h-3 w-2/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="h-2.5 w-3/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </span>
          <span className="h-6 w-16 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        </li>
      ))}
    </ul>
  )
}
