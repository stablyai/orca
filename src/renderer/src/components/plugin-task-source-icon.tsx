import { cn } from '@/lib/utils'

/** A plugin ships the shape only; `bg-current` paints every pixel from the
 *  surrounding `text-*` class, so the icon tracks the theme like the Lucide
 *  glyphs beside it. An `<img>` would paint the plugin's colours instead. */
export function PluginTaskSourceAssetIcon({
  dataUrl,
  className
}: {
  dataUrl: string
  className?: string
}): React.JSX.Element {
  const style: React.CSSProperties & { '--plugin-task-source-icon': string } = {
    '--plugin-task-source-icon': `url("${dataUrl}")`
  }
  return (
    <span
      aria-hidden
      className={cn('plugin-task-source-icon size-3.5 shrink-0 bg-current', className)}
      style={style}
    />
  )
}
