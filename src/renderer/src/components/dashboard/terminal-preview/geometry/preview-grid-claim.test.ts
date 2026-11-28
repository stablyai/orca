// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FitHoldMode } from '@/lib/pane-manager/terminal-fit/mobile-fit-overrides'
import { createPreviewGridClaim } from './preview-grid-claim'
import type * as PreviewApi from '../transport/terminal-preview-api'

// Who holds the grid, as a paired host last said (this app's main process never says).
let hold: FitHoldMode | undefined
vi.mock('../transport/terminal-preview-api', async (importOriginal) => ({
  ...(await importOriginal<typeof PreviewApi>()),
  terminalPreviewHoldMode: () => hold
}))

// This app's main process, which applies a claim to the PTY's size.
const fit = vi.fn(async () => null)
Object.defineProperty(window, 'api', { value: { terminalPreview: { fit } }, configurable: true })

/** A preview box 800×400 px around a 100×50 grid of 8×16 px cells; `width` resizes it. */
function previewBox(size = { width: 800 }): HTMLElement {
  const box = document.createElement('div')
  const container = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  container.append(screen)
  box.append(container)
  Object.defineProperties(box, {
    clientWidth: { get: () => size.width },
    clientHeight: { value: 400 }
  })
  Object.defineProperties(screen, { offsetWidth: { value: 800 }, offsetHeight: { value: 800 } })
  return container
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  fit.mockClear()
  hold = undefined
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

it('claims on the first keystroke, before the opening measure has run', () => {
  const claim = createPreviewGridClaim({
    ptyId: 'pty-mate',
    container: previewBox(),
    getTerminal: () => ({ cols: 100, rows: 50 }),
    onTyping: true
  })
  claim.schedule()
  claim.claimForInput('l')
  expect(fit).toHaveBeenCalledWith('pty-mate', 100, 25)
  claim.dispose()
})

it('follows this viewer’s window size only while it holds the grid', () => {
  const size = { width: 800 }
  const claim = createPreviewGridClaim({
    ptyId: 'pty-mate',
    container: previewBox(size),
    getTerminal: () => ({ cols: 100, rows: 50 }),
    onTyping: true
  })
  hold = 'remote-desktop-fit'
  size.width = 640
  claim.schedule()
  vi.runAllTimers()
  expect(fit).not.toHaveBeenCalled()
  // Typing took it: the host now says this viewer holds it, and a resize follows.
  hold = 'desktop-fit'
  size.width = 400
  claim.schedule()
  vi.runAllTimers()
  expect(fit).toHaveBeenCalledWith('pty-mate', 50, 25)
  claim.dispose()
})
