export function SessionDetailEmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed border-sidebar-border/80 px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
      {message}
    </div>
  )
}
