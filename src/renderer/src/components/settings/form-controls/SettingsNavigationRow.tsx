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
      data-settings-row-hover=""
      onClick={onClick}
      // The fill bleeds over the group card's px-5 inset so the card's rounded clip shapes it.
      className="relative isolate flex w-full items-center gap-5 py-2.5 text-left outline-none after:pointer-events-none after:absolute after:-inset-x-5 after:-top-px after:bottom-0 after:-z-10 hover:after:bg-foreground/5 focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring"
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
