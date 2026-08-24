import type React from 'react'
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, ImageIcon } from 'lucide-react'

import type { OrcaBackgroundLibraryImage } from '../../../../shared/orca-background-library-types'
import { browserBackgroundImageObjectUrls } from '../../lib/background-image-object-url'
import { Button } from '../ui/button'
import { createAppearancePreviewBackgroundObjectUrl } from './appearance-preview-background'
import { translate } from '@/i18n/i18n'

type AppearanceBackgroundImageSelectorProps = {
  images: readonly OrcaBackgroundLibraryImage[]
  selectedImage: string | null
  onSelect: (fileName: string) => void
}

function useSelectedBackgroundThumbnail(fileName: string | null): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let ownedUrl: string | null = null
    setObjectUrl(null)
    if (!fileName) {
      return
    }

    void createAppearancePreviewBackgroundObjectUrl(fileName).then((nextUrl) => {
      if (!nextUrl) {
        return
      }
      ownedUrl = nextUrl
      if (cancelled) {
        browserBackgroundImageObjectUrls.revoke(nextUrl)
      } else {
        setObjectUrl(nextUrl)
      }
    })

    return () => {
      cancelled = true
      if (ownedUrl) {
        browserBackgroundImageObjectUrls.revoke(ownedUrl)
      }
    }
  }, [fileName])

  return objectUrl
}

export function AppearanceBackgroundImageSelector({
  images,
  selectedImage,
  onSelect
}: AppearanceBackgroundImageSelectorProps): React.JSX.Element | null {
  const selectedIndex = images.findIndex((image) => image.fileName === selectedImage)
  const thumbnailUrl = useSelectedBackgroundThumbnail(selectedImage)
  if (!selectedImage) {
    return null
  }

  const canNavigate = images.length > 1 && selectedIndex !== -1
  const selectOffset = (offset: number): void => {
    const nextIndex = (selectedIndex + offset + images.length) % images.length
    const nextImage = images[nextIndex]
    if (nextImage) {
      onSelect(nextImage.fileName)
    }
  }

  return (
    <div className="flex items-center justify-center gap-2" aria-live="polite">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!canNavigate}
        aria-label={translate(
          'auto.components.settings.AppearanceBackgroundSection.previousImage',
          'Previous background image'
        )}
        onClick={() => selectOffset(-1)}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </Button>
      <div className="flex w-24 flex-col items-center gap-1.5">
        <div className="flex size-20 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={translate(
                'auto.components.settings.AppearanceBackgroundSection.imagePreview',
                'Preview of {{value0}}',
                { value0: selectedImage }
              )}
              className="size-full object-cover"
            />
          ) : (
            <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        <span className="w-full truncate text-center font-mono text-[11px] text-muted-foreground">
          {selectedImage}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!canNavigate}
        aria-label={translate(
          'auto.components.settings.AppearanceBackgroundSection.nextImage',
          'Next background image'
        )}
        onClick={() => selectOffset(1)}
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
    </div>
  )
}
