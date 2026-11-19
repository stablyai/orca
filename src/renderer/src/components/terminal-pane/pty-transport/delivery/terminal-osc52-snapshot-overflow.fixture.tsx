import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { advancePartialEscapeTail } from '../../../../../../shared/terminal/protocol/escape/terminal-partial-escape-tail'
import { TerminalStreamPosition } from './terminal-stream-position'

// #44623 visual proof: a long OSC 52 clipboard copy (long CJK text) crosses a snapshot boundary
// deep inside its Base64 payload. The hydrated pane re-arms the pending escape tail with the real
// production accumulator; the live continuation then completes the copy instead of printing it.
const CJK_SAMPLE = '把这段很长的中文文本复制到系统剪贴板，用于验证终端快照边界不泄漏。'

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function openTerminal(host: HTMLElement): Terminal {
  const styles = getComputedStyle(host)
  return new Terminal({
    cols: 84,
    rows: 12,
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    disableStdin: true,
    theme: {
      background: styles.backgroundColor,
      foreground: styles.color,
      cursor: styles.color,
      cursorAccent: styles.backgroundColor
    }
  })
}

export const snapshotOverflow = defineFixture({
  width: 700,
  render: () => (
    <div
      data-terminal-osc52-host
      className="h-[220px] overflow-hidden bg-background p-2 text-foreground"
    />
  ),
  interact: async (frame) => {
    const host = frame.querySelector<HTMLElement>('[data-terminal-osc52-host]')
    if (!host) {
      return
    }
    // xterm buffers writes; only a write callback proves the chunk is parsed, so every phase below
    // waits for its bytes before the next phase changes parser state.
    const write = (terminal: Terminal, data: string): Promise<void> =>
      new Promise((resolve) => {
        terminal.write(data, resolve)
      })
    const settle = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 160))
    }

    const ptyId = 'fixture-osc52'
    const prompt = '$ 在 tmux 中复制长中文文本并跨快照边界恢复\r\n'
    const payload = base64Utf8(CJK_SAMPLE.repeat(64))
    const osc52 = `\x1b]52;c;${payload}\x07`
    const after = '\r\n$ 复制完成，屏幕保持干净\r\n'

    // Live output up to a snapshot taken inside the OSC 52 payload, past the old 4096-unit carry cap.
    const live = prompt + osc52.slice(0, 6000)
    const boundary = live.length
    const position = new TerminalStreamPosition()
    const liveTerminal = openTerminal(host)
    liveTerminal.open(host)
    const admitted = position.admit(ptyId, live, {
      startSeq: 0,
      endSeq: boundary,
      startsAtGround: true,
      boundaryUnknown: false
    })
    await write(liveTerminal, admitted ?? '')

    // The pane rehydrates from the snapshot into a fresh terminal: serialized cells plus the
    // pending escape tail held by the real production accumulator (empty past the old carry cap).
    liveTerminal.dispose()
    host.replaceChildren()
    const hydrated = openTerminal(host)
    hydrated.open(host)
    await write(hydrated, prompt)
    const carry = advancePartialEscapeTail('', live)
    position.anchor(ptyId, boundary, carry)
    await write(hydrated, carry)

    // The live stream continues exactly where the snapshot stopped.
    const continuation = osc52.slice(live.length - prompt.length) + after
    const resumed = position.admit(ptyId, continuation, {
      startSeq: boundary,
      endSeq: boundary + continuation.length,
      startsAtGround: false,
      boundaryUnknown: false
    })
    await write(hydrated, resumed ?? '')
    await settle()
  }
})
