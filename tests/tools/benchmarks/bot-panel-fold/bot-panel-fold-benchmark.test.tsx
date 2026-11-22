// @vitest-environment happy-dom
// Bench, not a CI test: see vitest.bot-panel-fold-bench.config.ts beside it.
// What one fold costs with ROWS bot rows mounted and 0 or STORED folds saved: mount ms, ms per fold,
// and how many rows re-render (one, the folded bot's, when folds are read per bot).
import { act, cleanup, render } from '@testing-library/react'
import { it } from 'vitest'
import {
  useBotPanelFold,
  useBotPanelFolded,
  type BotPanelFold
} from '../../../../src/renderer/src/components/bots/use-bot-panel-fold'

const ROWS = Number(process.env.BENCH_ROWS ?? 500)
const STORED = Number(process.env.BENCH_STORED ?? 500)
const FOLDS = Number(process.env.BENCH_FOLDS ?? 20)

it(`one fold among ${ROWS} rows, with 0 and ${STORED} folds saved`, () => {
  for (const stored of [0, STORED]) {
    window.localStorage.setItem(
      'orca.bots.panelFolds',
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: stored }, (_, n) => [`stored-${n}`, ['suggestions', 'chats']])
        )
      )
    )
    const renders = Array.from({ length: ROWS }, () => 0)
    function Row({ n }: { n: number }): null {
      renders[n] += 1
      useBotPanelFolded(`bot-${n}`, 'suggestions')
      return null
    }
    let fold: BotPanelFold | null = null
    function Panel(): null {
      fold = useBotPanelFold('bot-7', 'suggestions')
      return null
    }
    const mountStart = performance.now()
    render(
      <>
        {renders.map((_, n) => (
          <Row key={n} n={n} />
        ))}
        <Panel />
      </>
    )
    const mountMs = performance.now() - mountStart
    renders.fill(0)
    const start = performance.now()
    for (let i = 0; i < FOLDS; i += 1) {
      act(() => fold?.onOpenChange(i % 2 === 1))
    }
    const perFoldMs = (performance.now() - start) / FOLDS
    console.info(
      `[bot panel fold] ${ROWS} rows x ${stored} saved: mount ${mountMs.toFixed(1)} ms, ` +
        `per fold ${perFoldMs.toFixed(2)} ms, rows re-rendered ${renders.filter(Boolean).length}`
    )
    cleanup()
    window.localStorage.clear()
  }
})
