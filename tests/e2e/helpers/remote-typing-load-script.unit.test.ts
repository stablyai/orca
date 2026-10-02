import '../../../src/main/daemon/xterm-env-polyfill'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { expect, it } from 'vitest'
import { remoteTypingLoadScript } from './remote-typing-load-script'

it.each([
  { rows: 12, cols: 80 },
  { rows: 24, cols: 80 },
  { rows: 40, cols: 80 },
  { rows: 12, cols: 35 },
  { rows: 24, cols: 35 },
  { rows: 40, cols: 35 }
])(
  'keeps typed output visible through background pressure at $rows rows and $cols columns',
  async ({ rows, cols }) => {
    const terminal = new Terminal({ rows, cols, scrollback: 1000, allowProposedApi: true })
    const serializer = new SerializeAddon()
    terminal.loadAddon(serializer)
    const runId = cols === 80 ? 'test' : '1790930671681_active'
    const input = new EventEmitter()
    const chunks: string[] = []
    let background = (): void => {
      throw new Error('Background pressure did not start')
    }
    try {
      runInNewContext(remoteTypingLoadScript(runId), {
        process: {
          stdin: {
            isTTY: true,
            setEncoding() {},
            setRawMode() {},
            resume() {},
            on: input.on.bind(input)
          },
          stdout: { rows, cols, write: (chunk: string) => chunks.push(chunk) },
          exit() {}
        },
        setTimeout: (callback: () => void) => callback(),
        setInterval: (callback: () => void) => {
          background = callback
          return 1
        },
        clearInterval() {}
      })
      input.emit('data', cols === 80 ? 'ab\r\ncd' : 'abcdefghij\r\n')
      for (let frame = 0; frame < 40; frame += 1) {
        background()
      }
      const output = chunks.join('')
      expect(output.length).toBeGreaterThan(160_000)
      await new Promise<void>((resolve) => terminal.write(output, resolve))
      const screen = Array.from(
        { length: rows },
        (_, row) =>
          terminal.buffer.active
            .getLine(terminal.buffer.active.baseY + row)
            ?.translateToString(true) ?? ''
      ).join('\n')
      const reply = cols === 80 ? 'KEY_test_4_d' : `KEY_${runId}_10_j`
      expect(screen).toContain(reply)
      expect(serializer.serialize()).toContain(reply)
    } finally {
      terminal.dispose()
    }
  }
)
