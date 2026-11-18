import { useEffect, useRef, useState } from 'react'

const CREATE_ROW_TOOLTIP_DELAY_MS = 600
const CREATE_ROW_TOOLTIP_SKIP_DELAY_MS = 300

type CreateRowHoverOptions = {
  /** A touch or held button is a press or drag, not hover intent. */
  pressed?: boolean
  /** The keyboard cursor's label is showing, so the pointer takes over without a cold wait. */
  labelShowing?: boolean
}

/**
 * Which create-row icon shows its pointer tooltip. The row's tooltips are controlled (the keyboard
 * cursor opens them too), so Radix's provider delays never apply; this restores hover intent:
 * wait on first hover, open neighbours at once while a label was just showing, and stay closed
 * after a press until the pointer leaves the icon.
 */
export function useCreateRowHoverTooltip(): {
  tooltipIndex: number | null
  hover: (index: number | null, options?: CreateRowHoverOptions) => void
  press: () => void
} {
  const [tooltipIndex, setTooltipIndex] = useState<number | null>(null)
  const hovered = useRef<number | null>(null)
  const shown = useRef(false)
  const warm = useRef(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = (timer: typeof openTimer): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }
  const show = (index: number | null): void => {
    shown.current = index !== null
    setTooltipIndex(index)
  }

  useEffect(
    () => () => {
      clearTimer(openTimer)
      clearTimer(skipTimer)
    },
    []
  )

  const hover = (
    index: number | null,
    { pressed = false, labelShowing = false }: CreateRowHoverOptions = {}
  ): void => {
    // Pointermove repeats on one icon; only a change of icon restarts the timing.
    if (index === hovered.current) {
      return
    }
    hovered.current = index
    clearTimer(openTimer)
    if (index === null) {
      if (shown.current) {
        show(null)
        warm.current = true
        clearTimer(skipTimer)
        skipTimer.current = setTimeout(() => {
          warm.current = false
          skipTimer.current = null
        }, CREATE_ROW_TOOLTIP_SKIP_DELAY_MS)
      }
      return
    }
    if (pressed) {
      // Hovered stays this icon, so releasing here keeps the label closed until the pointer leaves.
      if (shown.current) {
        show(null)
      }
      return
    }
    if (shown.current || warm.current || labelShowing) {
      show(index)
      return
    }
    openTimer.current = setTimeout(() => {
      openTimer.current = null
      show(index)
    }, CREATE_ROW_TOOLTIP_DELAY_MS)
  }

  const press = (): void => {
    clearTimer(openTimer)
    clearTimer(skipTimer)
    warm.current = false
    show(null)
  }

  return { tooltipIndex, hover, press }
}
