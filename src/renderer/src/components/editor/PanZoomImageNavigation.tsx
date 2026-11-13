import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'

/** Steps a preview through a set of images; absent handlers mark the first or last image. */
export type PanZoomImageNavigation = {
  /** One-based. */
  position: number
  count: number
  onPrevious?: () => void
  onNext?: () => void
}

/** ←/→ outside text fields step the preview, and stay claimed at either end. */
export function handlePanZoomNavigationKey(
  event: React.KeyboardEvent,
  navigation: PanZoomImageNavigation | undefined
): void {
  if (
    !navigation ||
    (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
    event.defaultPrevented ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    isEditableTarget(event.target)
  ) {
    return
  }
  event.preventDefault()
  ;(event.key === 'ArrowLeft' ? navigation.onPrevious : navigation.onNext)?.()
}

export function PanZoomImagePosition({
  navigation
}: {
  navigation: PanZoomImageNavigation
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span
      data-pan-zoom-position
      className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-sm tabular-nums text-muted-foreground shadow-xs"
    >
      {t('auto.components.editor.PanZoomImageDialog.position', '{{value0}} / {{value1}}', {
        value0: navigation.position,
        value1: navigation.count
      })}
    </span>
  )
}

function StepButton({
  side,
  label,
  onStep
}: {
  side: 'previous' | 'next'
  label: string
  onStep: (() => void) | undefined
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          data-pan-zoom-navigation={side}
          aria-label={label}
          disabled={!onStep}
          onClick={onStep}
          className={
            side === 'previous'
              ? 'pointer-events-auto absolute top-1/2 left-3 -translate-y-1/2'
              : 'pointer-events-auto absolute top-1/2 right-3 -translate-y-1/2'
          }
        >
          {side === 'previous' ? <ChevronLeft /> : <ChevronRight />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side === 'previous' ? 'right' : 'left'}>{label}</TooltipContent>
    </Tooltip>
  )
}

export function PanZoomImageStepButtons({
  navigation
}: {
  navigation: PanZoomImageNavigation
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <StepButton
        side="previous"
        label={t('auto.components.editor.PanZoomImageDialog.previous', 'Previous image')}
        onStep={navigation.onPrevious}
      />
      <StepButton
        side="next"
        label={t('auto.components.editor.PanZoomImageDialog.next', 'Next image')}
        onStep={navigation.onNext}
      />
    </>
  )
}
