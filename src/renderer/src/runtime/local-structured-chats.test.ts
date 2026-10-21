import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ held: false, isWebClient: false }))

vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.isWebClient }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./local-structured-session-tabs-sync/inventory-refresh', () => ({
  restoreLocalStructuredSessionTabsOnce: vi.fn(async () => undefined)
}))

import {
  resetLocalStructuredChatsForTests,
  restoreLocalStructuredChatsAtStartup
} from './local-structured-chats'

const SETTING_OFF = { experimentalNativeChat: false }
const SETTING_ON = { experimentalNativeChat: true }

beforeEach(() => {
  mocks.held = false
  mocks.isWebClient = false
  resetLocalStructuredChatsForTests()
  vi.stubGlobal('window', {
    api: {
      app: {
        holdsStructuredAgentSessions: async () => mocks.held,
        onStructuredAgentSessionsHeldChanged: () => () => undefined
      }
    }
  })
})

describe("startup's restore of this machine's structured chats", () => {
  it('runs no session-tab census for a default user who never held a chat', async () => {
    const step = vi.fn(async () => undefined)

    await restoreLocalStructuredChatsAtStartup(SETTING_OFF, step)

    expect(step).not.toHaveBeenCalled()
  })

  // Existing chats come back whatever the setting says.
  it('restores the chats this machine holds with the setting off', async () => {
    mocks.held = true
    const step = vi.fn(async () => undefined)

    await restoreLocalStructuredChatsAtStartup(SETTING_OFF, step)

    expect(step).toHaveBeenCalledOnce()
  })

  it('restores when the setting launches structured chats', async () => {
    const step = vi.fn(async () => undefined)

    await restoreLocalStructuredChatsAtStartup(SETTING_ON, step)

    expect(step).toHaveBeenCalledOnce()
  })

  it('never restores in the browser client', async () => {
    mocks.isWebClient = true
    mocks.held = true
    const step = vi.fn(async () => undefined)

    await restoreLocalStructuredChatsAtStartup(SETTING_ON, step)

    expect(step).not.toHaveBeenCalled()
  })
})
