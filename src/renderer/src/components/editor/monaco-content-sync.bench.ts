// @vitest-environment happy-dom
import { bench, expect } from 'vitest'
import * as monaco from 'monaco-editor'
import { syncContentUpdate } from './monaco-content-sync'

const SAMPLE_COUNT = 30
const WARMUP_COUNT = 5

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
}

async function settleBetweenArms(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) {
    throw new Error('Forced GC unavailable; run the benchmark with node --expose-gc')
  }
  gc()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function measureReconciliation(
  initial: string,
  appended: string,
  rewritten: string
): Promise<{ appendSamples: number[]; replacementSamples: number[] }> {
  const appendSamples: number[] = []
  const replacementSamples: number[] = []
  const measure = (next: string): number => {
    const model = monaco.editor.createModel(initial, 'plaintext')
    const editorInstance = {
      getModel: () => model,
      pushUndoStop: () => true
    } as unknown as monaco.editor.IStandaloneCodeEditor
    const startedAt = performance.now()
    syncContentUpdate(editorInstance, next)
    const duration = performance.now() - startedAt
    model.dispose()
    return duration
  }
  for (let index = 0; index < WARMUP_COUNT + SAMPLE_COUNT; index++) {
    const appendDuration = measure(appended)
    await settleBetweenArms()
    const replacementDuration = measure(rewritten)
    await settleBetweenArms()
    if (index >= WARMUP_COUNT) {
      appendSamples.push(appendDuration)
      replacementSamples.push(replacementDuration)
    }
  }
  return { appendSamples, replacementSamples }
}

async function runReconciliationBenchmark(
  label: string,
  bytes: number,
  maxAppendP95Ms: number
): Promise<void> {
  const base = `header\n${'x'.repeat(bytes - 8)}`
  const appended = `${base}\n{"type":"tail"}`
  const rewritten = `H${base.slice(1)}`
  const { appendSamples, replacementSamples } = await measureReconciliation(
    base,
    appended,
    rewritten
  )
  const appendP95 = percentile95(appendSamples)
  const replacementP95 = percentile95(replacementSamples)
  console.log(`[monaco-content-sync] ${label} ${JSON.stringify({ appendP95, replacementP95 })}`)
  expect(appendP95).toBeLessThan(maxAppendP95Ms)
  expect(replacementP95 / appendP95).toBeGreaterThanOrEqual(2)
}

bench(
  '9 MiB append and replacement p95',
  () => runReconciliationBenchmark('9 MiB model', 9 * 1024 * 1024, 50),
  { iterations: 1, time: 1, warmupIterations: 0, warmupTime: 0 }
)

bench(
  '50 MiB append and replacement p95',
  () => runReconciliationBenchmark('50 MiB model', 50 * 1024 * 1024, 100),
  { iterations: 1, time: 1, warmupIterations: 0, warmupTime: 0 }
)
