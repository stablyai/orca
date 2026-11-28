// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfirmationDialogSurface,
  type ConfirmationDialogRequest
} from './ConfirmationDialogSurface'
import type { ConfirmationDialogOptions } from './confirmation-dialog-context'

// happy-dom lays nothing out; the dialog overflows when its content reports more than it shows.
let contentHeight = 0
let shownHeight = 0
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  contentHeight = 0
  shownHeight = 0
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.slot === 'dialog-content' ? contentHeight : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.slot === 'dialog-content' ? shownHeight : 0
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

let nextId = 0
function request(options: Partial<ConfirmationDialogOptions> = {}): ConfirmationDialogRequest {
  nextId += 1
  return {
    id: nextId,
    options: { title: `Request ${nextId}`, confirmLabel: 'Give access', ...options },
    resolve: () => {}
  }
}

async function show(
  active: ConfirmationDialogRequest
): Promise<(next: ConfirmationDialogRequest) => Promise<void>> {
  const onSettle = vi.fn()
  const view = render(<ConfirmationDialogSurface activeRequest={active} onSettle={onSettle} />)
  await act(async () => {})
  return async (next) => {
    view.rerender(<ConfirmationDialogSurface activeRequest={next} onSettle={onSettle} />)
    await act(async () => {})
  }
}

const title = (): HTMLElement => screen.getByRole('heading')
const cancel = (): HTMLElement => screen.getByRole('button', { name: 'Cancel' })
const giveAccess = (): HTMLElement => screen.getByRole('button', { name: 'Give access' })

describe('confirmation initial focus', () => {
  it('leaves a caller without scrollable on Cancel, with a plain title, even when tall', async () => {
    contentHeight = 900
    shownHeight = 300
    await show(request())
    expect(document.activeElement).toBe(cancel())
    expect(title().hasAttribute('tabindex')).toBe(false)
  })

  it('keeps initialFocus confirm for a caller without scrollable', async () => {
    await show(request({ initialFocus: 'confirm' }))
    expect(document.activeElement).toBe(giveAccess())
  })

  it('starts a scrollable confirm that fits on Cancel', async () => {
    contentHeight = 300
    shownHeight = 300
    await show(request({ scrollable: true }))
    expect(document.activeElement).toBe(cancel())
  })

  it('rests on the title, never a button, when a scrollable confirm overflows', async () => {
    contentHeight = 900
    shownHeight = 300
    await show(request({ scrollable: true }))
    expect(document.activeElement).toBe(title())
    expect(title().getAttribute('tabindex')).toBe('-1')
  })

  it('does so even when the caller asked for the confirm button', async () => {
    contentHeight = 900
    shownHeight = 300
    await show(request({ scrollable: true, initialFocus: 'confirm' }))
    expect(document.activeElement).toBe(title())
  })

  it('starts each queued request at the top, on its title', async () => {
    contentHeight = 900
    shownHeight = 300
    const next = await show(request({ scrollable: true }))
    const content = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
    if (!content) {
      throw new Error('dialog content missing')
    }
    cancel().focus()
    content.scrollTop = 600
    await next(request({ scrollable: true }))
    expect(screen.getByRole('heading').textContent).toBe(`Request ${nextId}`)
    expect(document.activeElement).toBe(title())
    expect(content.scrollTop).toBe(0)
  })
})
