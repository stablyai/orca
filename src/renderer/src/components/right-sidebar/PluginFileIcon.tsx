import type React from 'react'
import type { PluginIconThemeAsset } from '../../../../shared/plugins/plugin-icon-theme-artifact'
import { cn } from '@/lib/utils'

type PluginFileIconProps = {
  asset: PluginIconThemeAsset
  className?: string
  color?: string
}

export function PluginFileIcon({
  asset,
  className,
  color
}: PluginFileIconProps): React.JSX.Element {
  if (!asset.monochrome && !color) {
    return (
      <img
        aria-hidden="true"
        alt=""
        src={asset.src}
        draggable={false}
        className={cn('object-contain', className)}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn('inline-block bg-current', className)}
      style={{
        backgroundColor: color,
        WebkitMaskImage: `url(${asset.src})`,
        WebkitMaskPosition: 'center',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskImage: `url(${asset.src})`,
        maskPosition: 'center',
        maskRepeat: 'no-repeat',
        maskSize: 'contain'
      }}
    />
  )
}
