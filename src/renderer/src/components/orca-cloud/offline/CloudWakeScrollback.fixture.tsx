// WAKE-SCROLLBACK: a real xterm after Sleep → Wake. Each fixture writes the pre-sleep output, runs
// the actual capture, the woken terminal's snapshot (it clears the pane) and the restore after it,
// so what shows is what the pane shows.
import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  armWakeScrollback,
  beginWakeScrollbackRestore,
  captureWakeScrollback,
  finishWakeScrollbackRestore
} from '@/lib/orca-cloud/cloud-wake-scrollback'

const SLEPT_AT = new Date(2026, 10, 11, 14, 2).getTime()
const WOKE_AT = new Date(2026, 10, 11, 14, 31).getTime()
const SNAPSHOT_CLEAR = '\x1b[2J\x1b[3J\x1b[H'

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

type Sleep = { before: string; agentPane?: boolean; after: string; sleptAt?: number }

function WokeTerminal({ id, sleeps }: { id: string; sleeps: Sleep[] }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) {
      return
    }
    const dark = document.documentElement.classList.contains('dark')
    const terminal = new Terminal({
      cols: 72,
      rows: 12,
      fontSize: 12,
      fontFamily: 'Menlo, monospace',
      theme: dark
        ? { background: '#0a0a0a', foreground: '#e5e5e5', cursor: '#e5e5e5' }
        : { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328' }
    })
    terminal.open(host.current)
    void (async () => {
      for (const [index, sleep] of sleeps.entries()) {
        await write(terminal, sleep.before)
        captureWakeScrollback(id, terminal, {
          sleptAt: sleep.sleptAt ?? SLEPT_AT + index * 7_200_000,
          agentPane: sleep.agentPane ?? false,
          maxRows: 5000
        })
        armWakeScrollback([id])
        const restore = beginWakeScrollbackRestore(id, terminal, WOKE_AT + index * 7_200_000)
        await write(terminal, `${SNAPSHOT_CLEAR}${sleep.after}`)
        if (restore) {
          await finishWakeScrollbackRestore(restore, terminal, (data) => write(terminal, data))
        }
      }
      terminal.scrollToBottom()
    })()
    return () => terminal.dispose()
  }, [id, sleeps])
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background p-2">
      <div ref={host} />
    </div>
  )
}

const PROMPT = '\x1b[32mubuntu@sbx\x1b[0m:\x1b[34m~/hello-world\x1b[0m$ '
const testRun = [
  `${PROMPT}pnpm test`,
  '',
  ' \x1b[32m✓\x1b[0m src/util.test.ts \x1b[2m(4 tests)\x1b[0m',
  ' \x1b[32m✓\x1b[0m src/logging.test.ts \x1b[2m(2 tests)\x1b[0m',
  ' \x1b[31m✗\x1b[0m src/server.test.ts \x1b[2m(1 failed)\x1b[0m',
  '',
  ' \x1b[1mTest Files\x1b[0m  \x1b[31m1 failed\x1b[0m | \x1b[32m2 passed\x1b[0m',
  `${PROMPT}sleep 900`,
  ''
].join('\r\n')

/** A shell pane: its output (in its own colours) above the divider, the woken prompt below. */
export const shellPaneRestored = defineFixture({
  width: 720,
  render: () => <WokeTerminal id="fixture-shell" sleeps={[{ before: testRun, after: PROMPT }]} />
})

/** Two sleeps: one divider each, in order. */
export const twoSleeps = defineFixture({
  width: 720,
  render: () => (
    <WokeTerminal
      id="fixture-two"
      sleeps={[
        { before: `${PROMPT}echo first\r\nfirst\r\n${PROMPT}`, after: PROMPT },
        { before: `echo second\r\nsecond\r\n${PROMPT}`, after: PROMPT }
      ]}
    />
  )
})

/** An agent pane: only the scrollback above Claude's screen; never its frozen input box. */
export const agentPaneScrollbackOnly = defineFixture({
  width: 720,
  render: () => (
    <WokeTerminal
      id="fixture-agent"
      sleeps={[
        {
          before: [
            `${PROMPT}git log --oneline -3`,
            '\x1b[33m4f1c2ab\x1b[0m fix: retry the upload',
            '\x1b[33m9d0e771\x1b[0m feat: logging util',
            '\x1b[33m2b6a0c4\x1b[0m chore: bump deps',
            `${PROMPT}claude`,
            ...Array.from({ length: 8 }, () => ''),
            '╭──────────────────────────────────────────╮',
            '│ > Try "create a util logging.py that..." │',
            '╰──────────────────────────────────────────╯',
            '  ? for shortcuts'
          ].join('\r\n'),
          agentPane: true,
          after: '\x1b[2m(Claude relaunching…)\x1b[0m'
        }
      ]}
    />
  )
})
