import React, { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import type { SessionGridWheelTarget } from '../../../src/shared/session-grid-types'
import { useSessionGridScroll } from '../../../src/renderer/src/components/session-grid/use-session-grid-scroll'
import { attachTerminalMouseWheelMultiplier } from '../../../src/renderer/src/lib/pane-manager/pane-terminal-mouse-wheel'

type Card = { kind: string; terminal: Terminal; data: string[] }
const cards: Card[] = []
let changeMode: (mode: SessionGridWheelTarget) => void

function Harness(): React.JSX.Element {
  const [mode, setMode] = useState<SessionGridWheelTarget>('terminal')
  useLayoutEffect(() => {
    changeMode = setMode
  }, [])
  const grid = useSessionGridScroll({
    mode: 'free',
    wheelTarget: mode,
    rowsPerView: 1,
    totalRowCount: 5,
    totalPageCount: 5
  })
  useLayoutEffect(() => {
    const element = document.querySelector('#grid')!
    const dispose: (() => void)[] = []
    for (const kind of ['normal', 'mouse', 'alternate']) {
      const card = document.createElement('div')
      card.id = kind
      card.style.cssText = 'height: 220px; overflow: hidden; margin: 10px'
      element.appendChild(card)
      const terminal = new Terminal({
        rows: 10,
        cols: 60,
        allowProposedApi: true,
        scrollback: 1000
      })
      terminal.open(card)
      attachTerminalMouseWheelMultiplier(terminal)
      const item: Card = { kind, terminal, data: [] }
      terminal.onData((data) => item.data.push(data))
      dispose.push(() => terminal.dispose())
      cards.push(item)
    }
    const spacer = document.createElement('div')
    spacer.style.height = '1000px'
    element.appendChild(spacer)
    return () => dispose.forEach((fn) => fn())
  }, [])
  return (
    <div
      id="grid"
      ref={grid.setScrollContainer}
      style={{ height: 720, width: 800, overflowY: 'auto' }}
    />
  )
}

const harness = {
  async seed(): Promise<void> {
    for (const item of cards) {
      let data = Array.from({ length: 50 }, (_, i) => `line ${i}\r\n`).join('')
      if (item.kind !== 'normal') {
        data = `\x1b[?1049h${data}`
      }
      if (item.kind === 'mouse') {
        data += '\x1b[?1003h\x1b[?1006h'
      }
      await new Promise<void>((resolve) => item.terminal.write(data, resolve))
    }
  },
  mode(mode: SessionGridWheelTarget): void {
    flushSync(() => changeMode(mode))
  },
  focus(kind: string | null): void {
    if (kind) {
      cards.find((card) => card.kind === kind)!.terminal.focus()
    } else {
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
  },
  viewport(kind: string, position: 'top' | 'middle' | 'bottom'): void {
    const terminal = cards.find((card) => card.kind === kind)!.terminal
    terminal.scrollToLine(
      position === 'top'
        ? 0
        : position === 'middle'
          ? Math.floor(terminal.buffer.active.baseY / 2)
          : terminal.buffer.active.baseY
    )
  },
  state() {
    return {
      grid: document.querySelector('#grid')!.scrollTop,
      focused: document.activeElement?.closest('[id]')?.id,
      activeTag: document.activeElement?.tagName,
      cards: cards.map((card) => ({
        kind: card.kind,
        viewport: card.terminal.buffer.active.viewportY,
        base: card.terminal.buffer.active.baseY,
        data: card.data
      }))
    }
  }
}

flushSync(() => createRoot(document.getElementById('root')!).render(<Harness />))
Object.assign(window, { scrollHarness: harness })
