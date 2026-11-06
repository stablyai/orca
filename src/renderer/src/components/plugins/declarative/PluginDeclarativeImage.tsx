import { useContext, useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { isPluginDeclarativeImagePath } from '../../../../../shared/plugins/declarative/plugin-declarative-content-props'
import { PluginDeclarativeHostServicesContext } from './plugin-declarative-assets'

/** A plugin file, read by main inside the plugin root; never a URL, so nothing leaves the machine. */
export function PluginDeclarativeImage({
  src,
  alt,
  size = 'full',
  fit = 'contain',
  rounded = false
}: PluginDeclarativeProps<'Image'>): React.JSX.Element {
  const { loadImage } = useContext(PluginDeclarativeHostServicesContext)
  const [loaded, setLoaded] = useState<{ src: string; url: string | null } | null>(null)
  useEffect(() => {
    if (!loadImage || !isPluginDeclarativeImagePath(src)) {
      return
    }
    let current = true
    void loadImage(src)
      .catch(() => null)
      .then((url) => {
        if (current) {
          setLoaded({ src, url })
        }
      })
    return () => {
      current = false
    }
  }, [loadImage, src])
  const url = loaded?.src === src ? loaded.url : undefined
  return (
    <span
      data-size={size}
      data-rounded={rounded}
      className="inline-flex max-w-full overflow-hidden data-[rounded=true]:rounded-md data-[size=full]:w-full data-[size=lg]:w-64 data-[size=md]:w-40 data-[size=sm]:w-24 data-[size=xs]:w-12"
    >
      {url ? (
        <img
          src={url}
          alt={alt}
          data-fit={fit}
          draggable={false}
          className="h-auto w-full data-[fit=contain]:object-contain data-[fit=cover]:aspect-square data-[fit=cover]:object-cover"
        />
      ) : url === null ? (
        <span
          role="img"
          aria-label={alt || undefined}
          className="flex aspect-video w-full items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"
        >
          <ImageOff aria-hidden className="size-4" />
        </span>
      ) : (
        <span aria-hidden className="block aspect-video w-full rounded-md bg-muted" />
      )}
    </span>
  )
}
