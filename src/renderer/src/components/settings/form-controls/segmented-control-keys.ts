import type React from 'react'

export type SegmentedOption<T extends string | number> = {
  value: T
  label: React.ReactNode
  disabled?: boolean
  ariaLabel?: string
  tooltip?: React.ReactNode
}

const STEPS: Readonly<Record<string, 1 | -1 | 'first' | 'last'>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: 'first',
  End: 'last'
}

/** Radiogroup arrow keys: the enabled option a key moves to, wrapping; null when the key does nothing. */
export function segmentedControlKeyTarget(
  key: string,
  current: number,
  disabled: readonly boolean[]
): number | null {
  const step = STEPS[key]
  const count = disabled.length
  if (step === undefined || count === 0) {
    return null
  }
  const delta = step === 'first' || step === 'last' ? (step === 'first' ? 1 : -1) : step
  let index = step === 'first' ? count - 1 : step === 'last' ? 0 : current
  for (let tried = 0; tried < count; tried += 1) {
    index = (index + delta + count) % count
    if (!disabled[index]) {
      return index === current ? null : index
    }
  }
  return null
}

/** Moves focus and selection within a segmented radiogroup; other keys pass through. */
export function handleSegmentedControlKeyDown<T>(
  event: React.KeyboardEvent<HTMLElement>,
  options: readonly { value: T; disabled?: boolean }[],
  onChange: (value: T) => void
): void {
  const radios = Array.from(event.currentTarget.querySelectorAll('[role="radio"]'))
  const focused = document.activeElement
  const current = focused ? radios.indexOf(focused) : -1
  if (current === -1) {
    return
  }
  const next = segmentedControlKeyTarget(
    event.key,
    current,
    options.map((option) => option.disabled === true)
  )
  const option = next === null ? undefined : options[next]
  const radio = next === null ? undefined : radios[next]
  if (!option || !(radio instanceof HTMLElement)) {
    return
  }
  event.preventDefault()
  radio.focus()
  onChange(option.value)
}
