import { LoadingSpinner } from './LoadingSpinner'

export function SidebarListLoadingState({ label }: { label: string }): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-xs text-muted-foreground"
    >
      <LoadingSpinner className="size-4 shrink-0" />
      <span>{label}</span>
    </div>
  )
}
