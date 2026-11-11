import { ChevronRight } from 'lucide-react'

export function SettingsNavigationRow({
  title,
  description,
  value,
  onClick
}: {
  title: string
  description?: string
  value?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-settings-row=""
      onClick={onClick}
      className="flex w-full items-center gap-5 py-2.5 text-left outline-none hover:bg-accent/50 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{title}</span>
        {description ? (
          <span className="mt-0.5 block text-settings-detail text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 max-w-[45%] items-center gap-2 text-settings-detail text-muted-foreground">
        {value ? (
          <span className="truncate" title={value}>
            {value}
          </span>
        ) : null}
        <ChevronRight className="size-4 shrink-0" />
      </span>
    </button>
  )
}
