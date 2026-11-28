// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPreviewGridClaim } from './preview-grid-claim'

// This app's main process, which applies a claim to the PTY's size.
const fit = vi.fn(async () => null)
Object.defineProperty(window, 'api', { value: { terminalPreview: { fit } }, configurable: true })

/** A preview box 800×400 px around a 100×50 grid of 8×16 px cells. */
function previewBox(): HTMLElement {
  const box = document.createElement('div')
  const container = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  container.append(screen)
  box.append(container)
  Object.defineProperties(box, { clientWidth: { value: 800 }, clientHeight: { value: 400 } })
  Object.defineProperties(screen, { offsetWidth: { value: 800 }, offsetHeight: { value: 800 } })
  return container
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  fit.mockClear()
})

it('takes another person’s terminal size only when this viewer types, as on a paired server', () => {
  const claim = createPreviewGridClaim({
    ptyId: 'pty-mate',
    container: previewBox(),
    getTerminal: () => ({ cols: 100, rows: 50 }),
    onTyping: true
  })
  // Opening and resizing the window measure the grid; they never take the size.
  claim.schedule()
  vi.runAllTimers()
  claim.schedule()
  vi.runAllTimers()
  expect(fit).not.toHaveBeenCalled()
  // A focus report is not typing.
  claim.claimForInput('\x1b[I')
  expect(fit).not.toHaveBeenCalled()
  claim.claimForInput('l')
  expect(fit).toHaveBeenCalledWith('pty-mate', 100, 25)
  claim.dispose()

  // The owner's own dashboard preview still fits the PTY to its dialog when it opens.
  const dialog = createPreviewGridClaim({
    ptyId: 'pty-own',
    container: previewBox(),
    getTerminal: () => ({ cols: 100, rows: 50 })
  })
  dialog.schedule()
  vi.runAllTimers()
  expect(fit).toHaveBeenLastCalledWith('pty-own', 100, 25)
  dialog.dispose()
})
