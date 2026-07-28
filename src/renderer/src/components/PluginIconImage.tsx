import type { CSSProperties } from 'react'
import type { PluginIconThemeImage } from '../../../shared/plugins/plugin-icon-theme-artifact'

type PluginIconImageProps = {
  image: PluginIconThemeImage
  className?: string
  size?: number
  style?: CSSProperties
}

export function PluginIconImage({
  image,
  className,
  size,
  style
}: PluginIconImageProps): React.JSX.Element {
  if (image.rendering === 'mask') {
    return (
      <span
        aria-hidden="true"
        className={className}
        style={{
          display: 'inline-block',
          flexShrink: 0,
          width: size,
          height: size,
          backgroundColor: 'currentColor',
          WebkitMaskImage: `url("${image.dataUrl}")`,
          maskImage: `url("${image.dataUrl}")`,
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          ...style
        }}
      />
    )
  }
  return (
    <img
      src={image.dataUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      style={style}
    />
  )
}
