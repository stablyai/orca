import type { FileDiffMetadata } from '@pierre/diffs'
import type { PierreDiffParseRequest, PierreDiffParseWorker } from './pierre-diff-parse-protocol'

type Task = {
  request: PierreDiffParseRequest
  resolve: (diff: FileDiffMetadata) => void
  reject: (error: Error) => void
  removeAbortListener: () => void
}
type Slot = { worker: PierreDiffParseWorker; task: Task | null }

export function createPierreDiffParseScheduler(
  createWorker: () => PierreDiffParseWorker,
  maxWorkers = 2
) {
  const slots = new Set<Slot>()
  const pending = new Map<number, Task>()
  let disposed = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const destroy = (slot: Slot): void => {
    slot.worker.onmessage = null
    slot.worker.onerror = null
    slot.worker.onmessageerror = null
    slot.worker.terminate()
    slots.delete(slot)
  }

  const finish = (slot: Slot, result: FileDiffMetadata | Error): void => {
    const task = slot.task
    slot.task = null
    task?.removeAbortListener()
    if (result instanceof Error) {
      destroy(slot)
      task?.reject(result)
    } else {
      task?.resolve(result)
    }
    drain()
  }

  const createSlot = (): Slot => {
    const worker = createWorker()
    const slot: Slot = { worker, task: null }
    worker.onmessage = ({ data }) => {
      if (data.id !== slot.task?.request.id) {
        return
      }
      finish(slot, 'error' in data ? new Error(data.error) : data.diff)
    }
    worker.onerror = (event) => finish(slot, new Error(event.message || 'Diff worker failed'))
    worker.onmessageerror = () => finish(slot, new Error('Could not read the computed diff'))
    slots.add(slot)
    return slot
  }

  const drain = (): void => {
    if (disposed) {
      return
    }
    while (pending.size > 0) {
      let slot = [...slots].find((entry) => entry.task === null)
      if (!slot && slots.size >= maxWorkers) {
        return
      }
      const task = pending.values().next().value!
      pending.delete(task.request.id)
      try {
        slot ??= createSlot()
        slot.task = task
        slot.worker.postMessage(task.request)
      } catch (error) {
        if (slot) {
          destroy(slot)
        }
        task.removeAbortListener()
        task.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (idleTimer === undefined && [...slots].every((slot) => slot.task === null)) {
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        for (const slot of slots) {
          destroy(slot)
        }
      }, 5_000)
    }
  }

  return {
    request(request: PierreDiffParseRequest, signal: AbortSignal): Promise<FileDiffMetadata> {
      if (disposed || signal.aborted) {
        return Promise.reject(new DOMException('Canceled', 'AbortError'))
      }
      clearTimeout(idleTimer)
      idleTimer = undefined
      // Mounted sections own admission; abandoned requests are removed synchronously.
      if (pending.size >= 64) {
        return Promise.reject(new Error('Too many diffs are loading. Retry this file.'))
      }
      return new Promise((resolve, reject) => {
        const abort = (): void => {
          pending.delete(request.id)
          for (const slot of slots) {
            if (slot.task?.request.id === request.id) {
              destroy(slot)
            }
          }
          signal.removeEventListener('abort', abort)
          reject(new DOMException('Canceled', 'AbortError'))
          drain()
        }
        signal.addEventListener('abort', abort, { once: true })
        pending.set(request.id, {
          request,
          resolve,
          reject,
          removeAbortListener: () => signal.removeEventListener('abort', abort)
        })
        drain()
      })
    },
    dispose(): void {
      disposed = true
      clearTimeout(idleTimer)
      const tasks = [
        ...pending.values(),
        ...[...slots].flatMap((slot) => (slot.task ? [slot.task] : []))
      ]
      pending.clear()
      for (const slot of slots) {
        destroy(slot)
      }
      for (const task of tasks) {
        task.removeAbortListener()
        task.reject(new DOMException('Canceled', 'AbortError'))
      }
    }
  }
}
