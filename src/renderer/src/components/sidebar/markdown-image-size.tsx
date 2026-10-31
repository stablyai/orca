import { useState, type ComponentProps } from 'react'

export function markdownImageSize(
  width?: number | string,
  height?: number | string,
  naturalHeight?: number
) {
  const percentWidth = typeof width === 'string' && /^\d+%$/.test(width) ? width : undefined
  const percentHeight = typeof height === 'string' && /^\d+%$/.test(height) ? height : undefined
  return {
    width: percentWidth ? undefined : width,
    height: percentHeight ? undefined : height,
    style: {
      width: percentWidth,
      // Markdown flows have no definite containing height; scale the loaded image itself.
      height:
        percentHeight && naturalHeight
          ? (naturalHeight * Number.parseInt(percentHeight, 10)) / 100
          : undefined
    }
  }
}

export function MarkdownSizedImage({
  src,
  width,
  height,
  style,
  onLoad,
  ...props
}: ComponentProps<'img'>) {
  const [loaded, setLoaded] = useState<{ src: string | undefined; height: number }>()
  const size = markdownImageSize(width, height, loaded?.src === src ? loaded?.height : undefined)
  return (
    <img
      {...props}
      src={src}
      width={size.width}
      height={size.height}
      style={{ ...style, ...size.style }}
      onLoad={(event) => {
        setLoaded({ src, height: event.currentTarget.naturalHeight })
        onLoad?.(event)
      }}
    />
  )
}
