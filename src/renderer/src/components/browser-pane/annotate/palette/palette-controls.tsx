import { Camera, Check, Copy, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import type { usePaletteHorizontalDrag } from './use-palette-horizontal-drag'

/** Grab's Copy and Screenshot; both act on the picked element (C and S keys still act on the hovered one). */
export function PaletteGrabActions({
  short: shortActions,
  copyDone: grabCopyDone,
  picked: grabPicked,
  canScreenshot: grabCanScreenshot,
  onCopy: onGrabCopy,
  onScreenshot: onGrabScreenshot
}: {
  short: boolean
  copyDone: boolean
  picked: boolean
  canScreenshot: boolean
  onCopy: () => void
  onScreenshot: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const pickFirstLabel = t('browser.annotatePalette.pickFirst', 'Pick an element first')
  return (
    <>
      {/* The span carries the tooltip: a disabled button gets no pointer events. */}
      <span
        className="flex shrink-0"
        title={
          grabPicked
            ? t('browser.annotatePalette.copyTitle', 'Copy the picked element')
            : pickFirstLabel
        }
      >
        <Button
          size={shortActions ? 'icon-xs' : 'xs'}
          variant="outline"
          onClick={onGrabCopy}
          disabled={!grabPicked}
          aria-label={t('browser.annotatePalette.copy', 'Copy')}
        >
          {grabCopyDone ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {shortActions
            ? null
            : grabCopyDone
              ? t('browser.annotatePalette.copied', 'Copied')
              : t('browser.annotatePalette.copy', 'Copy')}
        </Button>
      </span>
      <span
        className="flex shrink-0"
        title={
          grabCanScreenshot
            ? t(
                'browser.annotatePalette.screenshotTitle',
                'Copy a screenshot of the picked element'
              )
            : pickFirstLabel
        }
      >
        <Button
          size={shortActions ? 'icon-xs' : 'xs'}
          variant="outline"
          onClick={onGrabScreenshot}
          disabled={!grabCanScreenshot}
          aria-label={t('browser.annotatePalette.screenshot', 'Screenshot')}
        >
          <Camera className="size-3.5" />
          {shortActions ? null : t('browser.annotatePalette.screenshot', 'Screenshot')}
        </Button>
      </span>
    </>
  )
}

/** The palette's move handle: drag sideways, or use the arrow keys as a slider. */
export function PaletteGrip({
  percent,
  dragging,
  gripProps
}: {
  percent: number
  dragging: boolean
  gripProps: ReturnType<typeof usePaletteHorizontalDrag>['gripProps']
}): React.JSX.Element {
  const t = useTranslate()
  const altKeyLabel = getShortcutPlatform() === 'darwin' ? '⌥' : 'Alt'
  const side =
    percent < 34
      ? t('browser.annotatePalette.positionLeft', 'Left')
      : percent > 66
        ? t('browser.annotatePalette.positionRight', 'Right')
        : t('browser.annotatePalette.positionCentre', 'Centre')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="slider"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label={t('browser.annotatePalette.move', 'Move toolbar')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={t('browser.annotatePalette.positionValue', '{{side}}, {{percent}}%', {
            side,
            percent
          })}
          className={cn(
            'order-0 flex h-7 w-4 shrink-0 touch-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
            dragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
          {...gripProps}
        >
          <GripVertical className="size-3" />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {t(
          'browser.annotatePalette.moveTooltipSeeThrough',
          'Drag or use ← → to move · hold {{key}} to see under',
          { key: altKeyLabel }
        )}
      </TooltipContent>
    </Tooltip>
  )
}
