import { useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PluginHostImages } from '../../../../../shared/plugins/images/plugin-image-url'
import { useTranslate } from '@/i18n/use-translate'
import { PluginCardArt, type PluginArtPalette } from '../list/PluginCardArt'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { pluginArtShortcut, pluginArtTypes } from '../list/PluginRowArt'
import { retryPluginCatalogImage } from '../presentation/retry-plugin-catalog-image'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/dialog'

/** The page's 16:10 picture: the author's cover, else the card's drawn art. Space is reserved. */
export function PluginPageHero({
  entry,
  images,
  palettes
}: {
  entry: PluginListEntry
  images: PluginHostImages | undefined
  palettes: readonly PluginArtPalette[]
}): React.JSX.Element {
  const [failedCover, setFailedCover] = useState<string | null>(null)
  const cover = images?.cover
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-xl border border-border/70 bg-muted/40">
      {cover && cover.url !== failedCover ? (
        <img
          key={cover.url}
          src={cover.url}
          onError={(event) => {
            if (!retryPluginCatalogImage(event.currentTarget)) {
              setFailedCover(cover.url)
            }
          }}
          alt={cover.alt}
          width={cover.width}
          height={cover.height}
          decoding="async"
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <PluginCardArt
          types={pluginArtTypes(entry)}
          shortcut={pluginArtShortcut(entry)}
          fileType={entry.listing?.release?.fileTypes?.[0] ?? null}
          palettes={palettes}
          tintKey={entry.pluginKey}
          fill
        />
      )}
    </div>
  )
}

/** Screenshots as a scroll-snap strip; each opens large with its alt text, caption and position.
 *  A screenshot that is the cover (same verified bytes) isn't repeated. */
export function PluginScreenshots({
  images
}: {
  images: PluginHostImages | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState<string | null>(null)
  const [failedShots, setFailedShots] = useState<ReadonlySet<string>>(new Set())
  const thumbs = useRef(new Map<string, HTMLButtonElement>())
  const returnTo = useRef<string | null>(null)
  const shots = (images?.screenshots ?? [])
    .map((shot, index) => ({ ...shot, key: `${index}:${shot.url}` }))
    .filter(
      (shot) =>
        shot.url.split('?')[0] !== images?.cover?.url.split('?')[0] && !failedShots.has(shot.key)
    )
  if (shots.length === 0) {
    return null
  }
  const shownIndex = shots.findIndex((shot) => shot.key === open)
  const shown = shots[shownIndex] ?? null
  const hideShot = (key: string): void => {
    setFailedShots((current) => new Set([...current, key]))
    if (open === key) {
      setOpen(null)
    }
  }
  const step = (delta: number): void =>
    setOpen((current) =>
      current === null
        ? current
        : (shots[
            (shots.findIndex((shot) => shot.key === current) + delta + shots.length) % shots.length
          ]?.key ?? null)
    )
  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-baseline gap-2 px-0.5 text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        {t('auto.components.settings.PluginPageHero.screenshots', 'Screenshots')}
        <span className="font-normal tracking-normal normal-case">{shots.length}</span>
      </h3>
      <ul className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 scrollbar-sleek">
        {shots.map((shot) => (
          <li key={shot.key} className="w-60 shrink-0 snap-start">
            <button
              ref={(node) => {
                if (node) {
                  thumbs.current.set(shot.key, node)
                } else {
                  thumbs.current.delete(shot.key)
                }
              }}
              type="button"
              className="block w-full overflow-hidden rounded-lg border border-border/70 bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t(
                'auto.components.settings.PluginPageHero.openScreenshot',
                'Open screenshot: {{value0}}',
                { value0: shot.alt }
              )}
              onClick={() => {
                returnTo.current = shot.key
                setOpen(shot.key)
              }}
            >
              <img
                src={shot.url}
                onError={(event) => {
                  if (!retryPluginCatalogImage(event.currentTarget)) {
                    hideShot(shot.key)
                  }
                }}
                alt=""
                width={shot.width}
                height={shot.height}
                loading="lazy"
                decoding="async"
                className="block aspect-[16/10] w-full object-cover"
              />
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={shown !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent
          scrollable
          className="sm:max-w-5xl"
          onCloseAutoFocus={(event) => {
            // Why: the dialog opened from a thumbnail, so focus goes back to that one.
            event.preventDefault()
            thumbs.current.get(returnTo.current ?? '')?.focus()
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              step(1)
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault()
              step(-1)
            }
          }}
        >
          <DialogTitle className="sr-only">{shown?.alt ?? ''}</DialogTitle>
          {shown ? (
            <>
              {/* Why the top margin: the close button sits above the image, never over it. */}
              <img
                key={shown.key}
                src={shown.url}
                onError={(event) => {
                  if (!retryPluginCatalogImage(event.currentTarget)) {
                    hideShot(shown.key)
                  }
                }}
                alt={shown.alt}
                className="mt-6 block max-h-[calc(100vh-14rem)] w-full rounded-lg object-contain"
              />
              <div className="flex items-center gap-2">
                <DialogDescription className="min-w-0 flex-1">
                  {shown.caption ?? shown.alt}
                </DialogDescription>
                {shots.length > 1 ? (
                  <>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t(
                        'auto.components.settings.PluginPageHero.position',
                        '{{value0}} of {{value1}}',
                        {
                          value0: shownIndex + 1,
                          value1: shots.length
                        }
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t(
                        'auto.components.settings.PluginPageHero.previous',
                        'Previous screenshot'
                      )}
                      onClick={() => step(-1)}
                    >
                      <ChevronLeft />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t(
                        'auto.components.settings.PluginPageHero.next',
                        'Next screenshot'
                      )}
                      onClick={() => step(1)}
                    >
                      <ChevronRight />
                    </Button>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}
