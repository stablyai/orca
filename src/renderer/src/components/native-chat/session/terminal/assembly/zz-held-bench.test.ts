// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { useNativeChatAssembledMessages } from './use-native-chat-assembled-messages'
import { withHeldOlderHistory } from '../../../viewport/history/native-chat-pagination'

const row = (i: number, text = `row ${i}`): NativeChatMessage => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  blocks: [{ type: 'text', text }],
  timestamp: 1000 + i,
  source: 'transcript',
  transcriptOrder: i * 100
})
const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => row(from + k))

type P = { baseMessages: readonly NativeChatMessage[]; appended: NativeChatMessage[] }
function mount(initial: P) {
  return renderHook((p: P) => useNativeChatAssembledMessages({ agent: 'claude', sessionId: 's', ...p }), {
    initialProps: initial
  })
}
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

for (const H of [10_000, 100_000]) {
  it(`held=${H}`, () => {
    const reps = 7
    const out: Record<string, number> = {}
    // main+PR: one append frame (1 new row) over H held rows
    {
      const base = rows(0, H)
      const h = mount({ baseMessages: base, appended: [] })
      const ts: number[] = []
      let appended: NativeChatMessage[] = []
      for (let r = 0; r < reps; r++) {
        appended = [...appended, row(H + r)]
        const t = performance.now()
        h.rerender({ baseMessages: base, appended })
        ts.push(performance.now() - t)
      }
      out['append frame (main & PR)'] = median(ts)
      h.unmount()
    }
    // main+PR: older page load (+200 rows prepended => new base)
    {
      const ts: number[] = []
      for (let r = 0; r < reps; r++) {
        const h = mount({ baseMessages: rows(200, H), appended: [] })
        const next = rows(0, H)
        const t = performance.now()
        h.rerender({ baseMessages: next, appended: [] })
        ts.push(performance.now() - t)
        h.unmount()
      }
      out['older page load (main & PR)'] = median(ts)
    }
    // main: changed authoritative frame replaces base with the 300-row window
    {
      const ts: number[] = []
      for (let r = 0; r < reps; r++) {
        const h = mount({ baseMessages: rows(0, H), appended: [] })
        const window = [...rows(H - 300, H - 1), row(H - 1, `changed ${r}`)]
        const t = performance.now()
        h.rerender({ baseMessages: window, appended: [] })
        ts.push(performance.now() - t)
        h.unmount()
      }
      out['changed replacement (main: base := window)'] = median(ts)
    }
    // PR: changed authoritative frame keeps held prefix => new H-row base
    {
      const ts: number[] = []
      const helper: number[] = []
      for (let r = 0; r < reps; r++) {
        const base = rows(0, H)
        const h = mount({ baseMessages: base, appended: [] })
        const window = [...rows(H - 300, H - 1), row(H - 1, `changed ${r}`)]
        const t = performance.now()
        const next = withHeldOlderHistory('claude', { phase: 'ready', messages: base }, [], window, true)
        const t1 = performance.now()
        h.rerender({ baseMessages: next, appended: [] })
        ts.push(performance.now() - t)
        helper.push(t1 - t)
        h.unmount()
      }
      out['changed replacement (PR: held prefix + window)'] = median(ts)
      out['  of which withHeldOlderHistory'] = median(helper)
    }
    throw new Error('BENCH' + `\nheld=${H}\n` + Object.entries(out).map(([k, v]) => `  ${k}: ${v.toFixed(1)} ms`).join('\n') + '\n')
  }, 600_000)
}
