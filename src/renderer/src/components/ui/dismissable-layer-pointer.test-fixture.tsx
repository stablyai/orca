import type { ComponentProps } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import * as Layer from '@radix-ui/react-dismissable-layer'
import { vi } from 'vitest'

type LayerProps = ComponentProps<typeof Layer.Root>

export function pointer(target: Element, pointerType = 'mouse', button = 0) {
  const event = new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    pointerType,
    button
  })
  fireEvent(target, event)
  return event
}
export function mountLayer(props: LayerProps = {}) {
  const dismiss = vi.fn()
  const outside = vi.fn()
  const view = render(
    <Layer.Root data-testid="layer" onDismiss={dismiss} onPointerDownOutside={outside} {...props} />
  )
  return { ...view, dismiss, outside, node: screen.getByTestId('layer') }
}
