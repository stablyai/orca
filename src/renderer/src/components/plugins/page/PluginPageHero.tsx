import { useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { PluginHostImages } from '../../../../../shared/plugins/plugin-image-url'
import { translate } from '@/i18n/i18n'
import { PluginCardArt, type PluginArtPalette } from '../list/PluginCardArt'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { pluginArtShortcut, pluginArtTypes } from '../list/PluginRowArt'
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
  const cover = images?.cover
  return (
    // Why capped: the decision below the header must stay in view at 1280×800 and 900×700; a
    // taller column crops the 16:10 picture from its centre instead of growing.
    <div className="relative aspect-[16/10] max-h-64 w-full overflow-hidden rounded-xl border border-border/70 bg-muted/40">
      {cover ? (
        <img
          src={cover.url}
          alt={cover.alt}
          width={cover.width}
          height={cover.height}
          decoding="async"
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <PluginCardArt
          name={entry.name}
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
  const [open, setOpen] = useState<number | null>(null)
  const thumbs = useRef<(HTMLButtonElement | null)[]>([])
  const returnTo = useRef<number | null>(null)
  // Why the URL: it names the verified bytes by hash, so equal URLs are the same picture.
  const shots = (images?.screenshots ?? []).filter((shot) => shot.url !== images?.cover?.url)
  if (shots.length === 0) {
    return null
  }
  const shown = open === null ? null : shots[open]
  const step = (delta: number): void =>
    setOpen((current) =>
      current === null ? current : (current + delta + shots.length) % shots.length
    )
  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-baseline gap-2 px-0.5 text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        {translate('auto.components.settings.PluginPageHero.screenshots', 'Screenshots')}
        <span className="font-normal tracking-normal normal-case">{shots.length}</span>
      </h3>
      <ul className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 scrollbar-sleek">
        {shots.map((shot, index) => (
          <li key={shot.url} className="w-60 shrink-0 snap-start">
            <button
              ref={(node) => {
                thumbs.current[index] = node
              }}
              type="button"
              className="block w-full overflow-hidden rounded-lg border border-border/70 bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={translate(
                'auto.components.settings.PluginPageHero.openScreenshot',
                'Open screenshot: {{value0}}',
                { value0: shot.alt }
              )}
              onClick={() => {
                returnTo.current = index
                setOpen(index)
              }}
            >
              <img
                src={shot.url}
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
            thumbs.current[returnTo.current ?? 0]?.focus()
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
                src={shown.url}
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
                      {translate(
                        'auto.components.settings.PluginPageHero.position',
                        '{{value0}} of {{value1}}',
                        { value0: (open ?? 0) + 1, value1: shots.length }
                      )}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={translate(
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
                      aria-label={translate(
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
