import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

const viewer = { id: 'u1', fullName: 'Ada', email: 'ada@example.com' }

afterEach(() => vi.unstubAllGlobals())

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

  it('keeps showing connected when disconnect fails to delete the token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
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
  })
})
