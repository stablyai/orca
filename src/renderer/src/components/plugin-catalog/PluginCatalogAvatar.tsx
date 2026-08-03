import { cn } from '@/lib/utils'
import { pluginMonogram } from './plugin-display-name'

type PluginCatalogAvatarProps = {
  name: string
  className?: string
}

/** Quiet monogram tile — same footprint as the old icon well, unique per plugin. */
export function PluginCatalogAvatar({
  name,
  className
}: PluginCatalogAvatarProps): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50 text-[11px] font-semibold tracking-wide text-muted-foreground',
        className
      )}
    >
      {pluginMonogram(name)}
    </div>
  )
}
