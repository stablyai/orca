import type { ReactNode } from 'react'
import type { PluginIconThemeSlot } from '@/lib/plugin-icon-theme'
import { getPluginIconSlotImage } from '@/lib/plugin-icon-theme'
import { usePluginIconThemeStore } from '@/store/plugin-icon-themes'
import { PluginIconImage } from './PluginIconImage'

type PluginIconSlotProps = {
  slot: PluginIconThemeSlot
  fallback: ReactNode
  className?: string
  size?: number
}

export function PluginIconSlot({
  slot,
  fallback,
  className,
  size
}: PluginIconSlotProps): React.JSX.Element {
  const activeTheme = usePluginIconThemeStore((state) => state.activeTheme)
  const pluginIcon = getPluginIconSlotImage(activeTheme, slot)
  return pluginIcon ? (
    <PluginIconImage image={pluginIcon} size={size} className={className} />
  ) : (
    <>{fallback}</>
  )
}
