// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { parseDiffFromFile } from '@pierre/diffs'
import { WorkerPoolManager, type WorkerRequest, type WorkerResponse } from '@pierre/diffs/worker'

class HighlightWorker extends EventTarget implements Worker {
  onmessage: Worker['onmessage'] = null
  onmessageerror: Worker['onmessageerror'] = null
  onerror: Worker['onerror'] = null
  terminated = false
  initialize = true
  requests: WorkerRequest[] = []

  postMessage(request: WorkerRequest) {
    this.requests.push(request)
    const requestType = request.type
    if ((requestType === 'initialize' && this.initialize) || requestType === 'set-render-options') {
      queueMicrotask(() =>
        this.respond({ type: 'success', requestType, id: request.id, sentAt: 0 })
      )
    }
  }

  respond(response: WorkerResponse) {
    this.dispatchEvent(new MessageEvent('message', { data: response }))
  }

  terminate() {
    this.terminated = true
  }
}

const managers: WorkerPoolManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.terminate()
  }
  vi.restoreAllMocks()
})

async function setup(silentWorkerIndex?: number, allowStartupFailure = false) {
  const workers: HighlightWorker[] = []
  const manager = new WorkerPoolManager(
    {
      poolSize: 1,
      workerInitializationTimeout: 100,
      workerFactory: () => {
        const worker = new HighlightWorker()
        worker.initialize = workers.length !== silentWorkerIndex
        workers.push(worker)
        return worker
      },
      onWorkerError: () => {}
    },
    { theme: 'dark-plus', useTokenTransformer: true }
  )
  managers.push(manager)
  await manager.initialize().catch((error: unknown) => {
    if (!allowStartupFailure) {
      throw error
    }
  })
  const diff = {
    ...parseDiffFromFile(null, { name: 'file.ts', contents: 'const value = 1\n' }),
    cacheKey: 'file'
  }
  const instance = () => ({ __id: 'test', onHighlightSuccess: vi.fn(), onHighlightError: vi.fn() })
  const workerAt = (index: number) =>
    vi.waitFor(() => {
      const worker = workers[index]
      if (!worker) {
        throw new Error(`Worker ${index} has not been created`)
      }
      return worker
    })
  const requestFrom = (worker: HighlightWorker) =>
    vi.waitFor(() => {
      const request = worker.requests.find((request) => request.type === 'diff')
      if (!request || request.type !== 'diff') {
        throw new Error('Diff has not been dispatched')
      }
      return request
    })
  const complete = (worker: HighlightWorker, id: string) =>
    worker.respond({
      type: 'success',
      requestType: 'diff',
      id,
      sentAt: 0,
      options: manager.getDiffRenderOptions(),
      result: {
        code: { additionLines: [], deletionLines: [] },
        themeStyles: '',
        baseThemeType: undefined
      }
    })
  return { manager, diff, instance, workers, workerAt, requestFrom, complete }
}

it('keeps shared work alive, then replaces the worker when its last consumer cancels', async () => {
  const { manager, diff, instance, workers, workerAt, requestFrom, complete } = await setup()
  const first = instance(),
    survivor = instance(),
    successor = instance()
  manager.highlightDiffAST(first, diff)
  const worker = await workerAt(0)
  const abandoned = await requestFrom(worker)
  manager.highlightDiffAST(survivor, diff)
  manager.cleanUpTasks(first)
  expect(worker.terminated).toBe(false)
  expect(workers).toHaveLength(1)
  manager.cleanUpTasks(survivor)
  expect(worker.terminated).toBe(true)
  manager.highlightDiffAST(successor, diff)
  const replacement = await workerAt(1)
  const live = await requestFrom(replacement)
  complete(worker, abandoned.id)
  expect(successor.onHighlightSuccess).not.toHaveBeenCalled()
  complete(replacement, live.id)
  expect(successor.onHighlightSuccess).toHaveBeenCalledTimes(1)
  expect(first.onHighlightSuccess).not.toHaveBeenCalled()
  expect(survivor.onHighlightSuccess).not.toHaveBeenCalled()
  expect(replacement.terminated).toBe(false)
  expect(manager.getStats()).toMatchObject({
    activeTasks: 0,
    queuedTasks: 0,
    totalWorkers: 1,
    busyWorkers: 0
  })
})

it('reports a runtime crash and completes the next request on a replacement worker', async () => {
  const { manager, diff, instance, workerAt, requestFrom, complete } = await setup()
  const failed = instance(),
    successor = instance()
  manager.highlightDiffAST(failed, diff)
  const worker = await workerAt(0)
  await requestFrom(worker)
  worker.dispatchEvent(
    new ErrorEvent('error', { message: 'worker crashed', error: new Error('worker crashed') })
  )
  expect(failed.onHighlightError).toHaveBeenCalledTimes(1)
  expect(worker.terminated).toBe(true)
  manager.highlightDiffAST(successor, diff)
  const replacement = await workerAt(1)
  complete(replacement, (await requestFrom(replacement)).id)
  expect(successor.onHighlightSuccess).toHaveBeenCalledTimes(1)
  expect(manager.getStats()).toMatchObject({ activeTasks: 0, queuedTasks: 0, busyWorkers: 0 })
})

it('bounds replacement startup and lets a later request retry a failed replacement', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { manager, diff, instance, workerAt, requestFrom, complete } = await setup(1)
  const first = instance()
  manager.highlightDiffAST(first, diff)
  await requestFrom(await workerAt(0))
  manager.cleanUpTasks(first)
  const silent = await workerAt(1)
  const waiting = instance(),
    shared = instance()
  manager.highlightDiffAST(waiting, diff)
  manager.highlightDiffAST(shared, diff)
  await vi.waitFor(() => expect(silent.terminated).toBe(true))
  expect(waiting.onHighlightError).toHaveBeenCalledTimes(1)
  expect(shared.onHighlightError).toHaveBeenCalledTimes(1)
  expect(manager.getStats()).toMatchObject({ queuedTasks: 0, activeTasks: 0 })
  const successor = instance()
  manager.highlightDiffAST(successor, diff)
  const replacement = await workerAt(2)
  complete(replacement, (await requestFrom(replacement)).id)
  expect(successor.onHighlightSuccess).toHaveBeenCalledTimes(1)
  expect(manager.getStats()).toMatchObject({ activeTasks: 0, queuedTasks: 0, totalWorkers: 1 })
})

it('fails a silently hung shared job and gives queued work a fresh worker', async () => {
  const { manager, diff, instance, workers, workerAt, requestFrom, complete } = await setup()
  vi.useFakeTimers()
  try {
    const preparation = instance(),
      mounted = instance(),
      successor = instance()
    manager.highlightDiffAST(preparation, diff)
    const worker = await workerAt(0)
    await requestFrom(worker)
    manager.highlightDiffAST(mounted, diff)
    manager.highlightDiffAST(successor, { ...diff, cacheKey: 'next' })
    manager.cleanUpTasks(preparation)
    expect(worker.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(worker.terminated).toBe(true)
    expect(mounted.onHighlightError).toHaveBeenCalledTimes(1)
    const replacement = await workerAt(1)
    complete(replacement, (await requestFrom(replacement)).id)
    expect(successor.onHighlightSuccess).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(successor.onHighlightError).not.toHaveBeenCalled()
    expect(workers).toHaveLength(2)
    expect(manager.getStats()).toMatchObject({ activeTasks: 0, queuedTasks: 0, busyWorkers: 0 })
  } finally {
    vi.useRealTimers()
  }
})

it('accepts a fresh initialization after a failed startup', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { manager, diff, instance, workerAt, requestFrom, complete } = await setup(0, true)
  expect(manager.isWorkingPool()).toBe(false)
  const retry = manager.initialize()
  expect(manager.isWorkingPool()).toBe(true)
  await retry
  const successor = instance()
  manager.highlightDiffAST(successor, diff)
  const replacement = await workerAt(1)
  complete(replacement, (await requestFrom(replacement)).id)
  expect(successor.onHighlightSuccess).toHaveBeenCalledTimes(1)
})
