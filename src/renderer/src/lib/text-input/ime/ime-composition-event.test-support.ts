import { fireEvent } from '@testing-library/react'

/** happy-dom's CompositionEvent is a plain Event, so `fireEvent.compositionEnd` drops `data`. */
export function endComposition(element: HTMLElement, data: string): void {
  const event = new Event('compositionend', { bubbles: true })
  Object.defineProperty(event, 'data', { value: data })
  fireEvent(element, event)
}
