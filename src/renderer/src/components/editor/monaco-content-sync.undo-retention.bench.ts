// @vitest-environment happy-dom
import { bench, expect } from 'vitest'
import * as monaco from 'monaco-editor'
import { syncContentUpdate, type MonacoContentSyncMode } from './monaco-content-sync'

const MEBIBYTE = 1024 * 1024
const BATCH_COUNT = 5
const BATCH_BYTES = 10 * MEBIBYTE

type UndoStackElement = { heapSize: () => number }
type UndoRedoService = {
  getElements: (resource: monaco.Uri) => { past: UndoStackElement[]; future: UndoStackElement[] }
}

function undoHistoryBytes(model: monaco.editor.ITextModel): number {
  const service = (model as unknown as { _undoRedoService: UndoRedoService })._undoRedoService
  const elements = service.getElements(model.uri)
  return [...elements.past, ...elements.future].reduce(
    (total, element) => total + element.heapSize(),
    0
  )
}

async function forceGcAndSettle(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) {
    throw new Error('Forced GC unavailable; run the benchmark with node --expose-gc')
  }
  gc()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function measureUndoRetention(mode: MonacoContentSyncMode): Promise<{
  arrayBufferDelta: number
  canUndo: boolean
  undoBytes: number
}> {
  await forceGcAndSettle()
  const beforeArrayBuffers = process.memoryUsage().arrayBuffers
  const model = monaco.editor.createModel('', 'plaintext')
  const editorInstance = {
    getModel: () => model,
    pushUndoStop: () => {
      model.pushStackElement()
      return true
    }
  } as unknown as monaco.editor.IStandaloneCodeEditor
  let content = ''
  for (let batch = 0; batch < BATCH_COUNT; batch++) {
    content += String(batch % 10).repeat(BATCH_BYTES)
    syncContentUpdate(editorInstance, content, mode)
  }
  const canUndo = model.canUndo()
  const undoBytes = undoHistoryBytes(model)
  await forceGcAndSettle()
  const arrayBufferDelta = process.memoryUsage().arrayBuffers - beforeArrayBuffers
  model.dispose()
  await forceGcAndSettle()
  return { arrayBufferDelta, canUndo, undoBytes }
}

bench(
  '50 MiB read-only live-tail undo retention',
  async () => {
    const undoable = await measureUndoRetention('undoable')
    const readOnlyLiveTail = await measureUndoRetention('read-only-live-tail')
    console.log(
      `[monaco-content-sync] 50 MiB undo retention ${JSON.stringify({ undoable, readOnlyLiveTail })}`
    )
    expect(undoable.canUndo).toBe(true)
    expect(undoable.undoBytes).toBeGreaterThanOrEqual(BATCH_COUNT * BATCH_BYTES)
    expect(undoable.arrayBufferDelta).toBeGreaterThanOrEqual(BATCH_COUNT * BATCH_BYTES)
    expect(readOnlyLiveTail.canUndo).toBe(false)
    expect(readOnlyLiveTail.undoBytes).toBe(0)
    expect(readOnlyLiveTail.arrayBufferDelta).toBe(0)
  },
  { iterations: 1, time: 1, warmupIterations: 0, warmupTime: 0 }
)
