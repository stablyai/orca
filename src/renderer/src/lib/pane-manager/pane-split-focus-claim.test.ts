// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { claimSplitPaneFocus } from './pane-split-focus-claim'

afterEach(() => {
  document.body.innerHTML = ''
})

function createFrameQueue() {
  const queue: (() => void)[] = []
  return {
    requestFrame: (callback: () => void) => {
      queue.push(callback)
    },
    flushFrame: () => queue.shift()?.(),
    pending: () => queue.length
  }
}

function setup(
  options: {
    activePaneId?: () => number | null
    live?: () => boolean
    focusLands?: boolean
  } = {}
) {
  const container = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  container.append(textarea)
  document.body.append(container)
  const focus = vi.fn(() => {
    if (options.focusLands !== false) {
      textarea.focus()
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the claim and focusPanePreservingOverlays only call terminal.focus.
  const terminal = { focus } as unknown as Terminal
  const pane = { id: 2, container, terminal }
  const frames = createFrameQueue()
  claimSplitPaneFocus({
    pane,
    getActivePaneId: options.activePaneId ?? (() => pane.id),
    isPaneLive: options.live ?? (() => true),
    requestFrame: frames.requestFrame
  })
  return { focus, textarea, frames }
}

function appendOtherPaneTextarea(): HTMLTextAreaElement {
  const other = document.createElement('textarea')
  other.className = 'xterm-helper-textarea'
  document.body.append(other)
  return other
}

describe('claimSplitPaneFocus', () => {
  it('refocuses the new pane when focus fell back to the body', () => {
    const { focus, frames } = setup()
    frames.flushFrame()
    expect(focus).toHaveBeenCalledOnce()
  })

  it("refocuses the new pane when another pane's terminal input holds focus", () => {
    const { focus, frames } = setup()
    appendOtherPaneTextarea().focus()
    frames.flushFrame()
    expect(focus).toHaveBeenCalledOnce()
  })

  it('leaves focus alone when the new pane already owns it', () => {
    const { focus, textarea, frames } = setup()
    textarea.focus()
    frames.flushFrame()
    frames.flushFrame()
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not steal focus from a non-terminal input', () => {
    const { focus, frames } = setup()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    frames.flushFrame()
    frames.flushFrame()
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it('stops when the active pane changed before the first frame', () => {
    let activePaneId: number | null = 2
    const { focus, frames } = setup({ activePaneId: () => activePaneId })
    activePaneId = 1
    frames.flushFrame()
    expect(focus).not.toHaveBeenCalled()
    expect(frames.pending()).toBe(0)
  })

  it('stops when the pane was closed', () => {
    const { focus, frames } = setup({ live: () => false })
    frames.flushFrame()
    expect(focus).not.toHaveBeenCalled()
    expect(frames.pending()).toBe(0)
  })

  it('retries once more on the second frame, then gives up', () => {
    const { focus, frames } = setup({ focusLands: false })
    frames.flushFrame()
    expect(frames.pending()).toBe(1)
    frames.flushFrame()
    expect(focus).toHaveBeenCalledTimes(2)
    expect(frames.pending()).toBe(0)
  })
})
