import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const viewer = { id: 'u1', fullName: 'Ada', email: 'ada@example.com' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('todoist slice', () => {
  it('ignores a status read that resolves after connect', async () => {
    let resolveStatus: (value: unknown) => void = () => {}
    vi.stubGlobal('window', {
      api: {
        todoist: {
          status: () => new Promise((resolve) => (resolveStatus = resolve)),
          connect: async () => ({ ok: true, viewer })
        }
      }
    })
    const store = createTestStore()
    const check = store.getState().checkTodoistConnection()
    await store.getState().connectTodoist({ apiToken: 'tok' })
    resolveStatus({ connected: false, viewer: null })
    await check
    expect(store.getState().todoistStatus).toEqual({ connected: true, viewer })
  })

  it('still settles a pending status read when connect fails', async () => {
    let resolveStatus: (value: unknown) => void = () => {}
    vi.stubGlobal('window', {
      api: {
        todoist: {
          status: () => new Promise((resolve) => (resolveStatus = resolve)),
          connect: async () => ({ ok: false, error: 'Todoist rejected the API token.' })
        }
      }
    })
    const store = createTestStore()
    const check = store.getState().checkTodoistConnection()
    await store.getState().connectTodoist({ apiToken: 'bad' })
    resolveStatus({ connected: false, viewer: null })
    await check
    expect(store.getState().todoistStatusChecked).toBe(true)
  })

  it('keeps showing connected and tells the user when disconnect fails', async () => {
    vi.stubGlobal('window', {
      api: {
        todoist: {
          disconnect: async () => {
            throw new Error('EACCES')
          },
          status: async () => ({ connected: true, viewer })
        }
      }
    })
    const store = createTestStore()
    await store.getState().disconnectTodoist()
    expect(store.getState().todoistStatus).toEqual({ connected: true, viewer })
    expect(toast.error).toHaveBeenCalledWith('Couldn’t disconnect Todoist', {
      description: 'EACCES'
    })
  })
})
