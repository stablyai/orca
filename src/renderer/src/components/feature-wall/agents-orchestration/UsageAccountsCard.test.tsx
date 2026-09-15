// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const rateLimits: Record<string, unknown> = { claude: null, codex: null }
  return { claudeList: vi.fn(), codexList: vi.fn(), rateLimits }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      fetchSettings: async () => {},
      fetchRateLimits: async () => {},
      rateLimits: mocks.rateLimits
    })
}))

import { UsageAccountsCard } from './UsageAccountsCard'

const EMPTY_ACCOUNTS = { accounts: [], activeAccountId: null }
const UNKNOWN_TEXT = 'Account status unknown'
const NOT_SET_UP_TEXT = 'Tracking not set up'

let container: HTMLDivElement
let root: Root

async function renderCard(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<UsageAccountsCard />)
  })
}

describe('UsageAccountsCard account-list failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rateLimits = { claude: null, codex: null }
    Object.assign(window, {
      api: {
        claudeAccounts: { list: mocks.claudeList, add: vi.fn() },
        codexAccounts: { list: mocks.codexList, add: vi.fn() }
      }
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('stops asserting "Tracking not set up" for a provider whose list never loaded', async () => {
    mocks.claudeList.mockRejectedValue(new Error('offline'))
    mocks.codexList.mockResolvedValue(EMPTY_ACCOUNTS)

    await renderCard()

    const pills = Array.from(container.querySelectorAll('span')).map((node) => node.textContent)
    expect(pills).toContain(UNKNOWN_TEXT)
    // Why: only the failing provider goes unknown — Codex genuinely answered "none".
    expect(pills).toContain(NOT_SET_UP_TEXT)
  })

  it('keeps the real label when the list resolves empty', async () => {
    mocks.claudeList.mockResolvedValue(EMPTY_ACCOUNTS)
    mocks.codexList.mockResolvedValue(EMPTY_ACCOUNTS)

    await renderCard()

    expect(container.textContent).not.toContain(UNKNOWN_TEXT)
    expect(container.textContent).toContain(NOT_SET_UP_TEXT)
  })

  it('prefers the observed connection when rate limits already prove tracking is on', async () => {
    mocks.claudeList.mockRejectedValue(new Error('offline'))
    mocks.codexList.mockResolvedValue(EMPTY_ACCOUNTS)
    mocks.rateLimits = { claude: { status: 'ok', session: null, weekly: null }, codex: null }

    await renderCard()

    expect(container.textContent).not.toContain(UNKNOWN_TEXT)
    expect(container.textContent).toContain('Connected · System default')
  })

  it('does not claim tracking is unset while the account read is pending', async () => {
    let rejectClaude: (reason: Error) => void = () => {}
    mocks.claudeList.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectClaude = reject
      })
    )
    mocks.codexList.mockResolvedValue(EMPTY_ACCOUNTS)

    await renderCard()

    expect(container.textContent).toContain(UNKNOWN_TEXT)
    expect(container.textContent).toContain(NOT_SET_UP_TEXT)

    await act(async () => {
      rejectClaude(new Error('offline'))
      await Promise.resolve()
    })

    expect(container.textContent).toContain(UNKNOWN_TEXT)
  })
})
