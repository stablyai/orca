// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DATABASE_TAB_STATE } from '../../../../shared/database-types'
import { useDatabaseQuery } from './useDatabaseQuery'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), cancel: vi.fn() }))
vi.mock('@/runtime/runtime-database-client', () => ({
  executeDatabaseQuery: mocks.execute,
  cancelDatabaseQuery: mocks.cancel
}))

let root: Root
let container: HTMLDivElement
let current: ReturnType<typeof useDatabaseQuery>
let props: Parameters<typeof useDatabaseQuery>[0]
const response = {
  columns: [{ name: 'id', dataTypeId: 23 }],
  rows: [[1]],
  command: 'SELECT',
  rowCount: 1,
  truncated: false,
  durationMs: 5
}
function Probe(): null {
  current = useDatabaseQuery(props)
  return null
}
async function render(patch: Partial<typeof props> = {}): Promise<void> {
  props = { ...props, ...patch }
  await act(async () => {
    root.render(<Probe />)
  })
}
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
async function startRefreshing(): Promise<void> {
  await render()
  await act(async () => {
    await current.run()
  })
  await act(async () => {
    current.setRefreshSeconds(5)
  })
}

describe('database query lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    mocks.execute.mockReset().mockResolvedValue(response)
    mocks.cancel.mockReset().mockResolvedValue(true)
    props = {
      worktreeId: 'project',
      contextKey: 'connection-a',
      queryDraft: 'SELECT 1',
      request: { connection: DEFAULT_DATABASE_TAB_STATE.connection, credential: {} },
      readOnly: true,
      enabled: true,
      isActive: true
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  it('refreshes after completion without overlapping slow queries or manual requests', async () => {
    await startRefreshing()
    const pending = Promise.withResolvers<typeof response>()
    mocks.execute.mockReturnValueOnce(pending.promise)
    await tick(5000)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    await act(async () => {
      await current.run()
    })
    await tick(20000)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    await act(async () => {
      pending.resolve(response)
    })
    await tick(4999)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(mocks.execute).toHaveBeenCalledTimes(3)
  })

  it('pauses while the tab or document is hidden and resumes when visible', async () => {
    await startRefreshing()
    await render({ isActive: false })
    await tick(10000)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    await render({ isActive: true })
    await tick(5000)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick(10000)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick(5000)
    expect(mocks.execute).toHaveBeenCalledTimes(3)
  })

  it.each([{ queryDraft: 'DELETE FROM accounts' }, { readOnly: false }, { enabled: false }])(
    'stops automatic queries when input or access changes: %j',
    async (patch) => {
      await startRefreshing()
      await render(patch)
      await tick(10000)
      expect(mocks.execute).toHaveBeenCalledTimes(1)
      expect(current.refreshSeconds).toBe(0)
    }
  )

  it('stops after an error and keeps the last successful result visible', async () => {
    await startRefreshing()
    mocks.execute.mockRejectedValueOnce(new Error('connection lost'))
    await tick(5000)
    expect(current.error).toBe('connection lost')
    expect(current.result).toEqual(response)
    await tick(30000)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
  })

  it('cancels and discards a result from a previous connection', async () => {
    const pending = Promise.withResolvers<typeof response>()
    mocks.execute.mockReturnValueOnce(pending.promise)
    await render()
    let running: Promise<void>
    await act(async () => {
      running = current.run()
    })
    await render({ contextKey: 'connection-b' })
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve(response)
      await running
    })
    expect(current.result).toBeNull()
    expect(current.lastRun).toBeNull()
    expect(current.canRefresh).toBe(false)
  })

  it('forces table previews into read-only queries with a row bound', async () => {
    await render({ readOnly: false })
    await act(async () => {
      await current.run('SELECT * FROM "public"."events" LIMIT 500', true)
    })
    expect(mocks.execute).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({ readOnly: true, maxRows: 500, timeoutMs: 30000 })
    )
  })
})
