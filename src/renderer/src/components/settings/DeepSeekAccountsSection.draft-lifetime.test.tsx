// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeepSeekAccountStatus } from '../../../../shared/deepseek-balance'
import type {
  ProviderAccountsWatcher,
  watchProviderAccounts
} from '@/runtime/runtime-provider-accounts-client'

const backend = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  watch: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/deepseek-account-client', () => ({
  readDeepSeekAccount: backend.read,
  mutateDeepSeekAccount: backend.mutate,
  refreshDeepSeekAccount: vi.fn()
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  watchProviderAccounts: backend.watch
}))

import { DeepSeekAccountsSection } from './DeepSeekAccountsSection'

function status(ownerId: string | null, supported = true): DeepSeekAccountStatus {
  return { supported, ownerId, configured: false, protection: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('DeepSeek credential draft lifetime', () => {
  let root: Root
  let container: HTMLDivElement
  let publish: Parameters<typeof watchProviderAccounts>[1]['onSnapshot']
  let close = vi.fn<() => void>()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    backend.read.mockResolvedValue(status('owner-a'))
    backend.mutate.mockResolvedValue(status('owner-a'))
    close = vi.fn()
    backend.watch.mockImplementation(
      (
        _scope: unknown,
        callbacks: Parameters<typeof watchProviderAccounts>[1]
      ): ProviderAccountsWatcher => {
        publish = callbacks.onSnapshot
        return { close }
      }
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  async function render(environmentId = 'synthetic-host', unsupportedRuntime = false) {
    await act(async () => {
      root.render(
        <DeepSeekAccountsSection
          environmentId={environmentId}
          unsupportedRuntime={unsupportedRuntime}
          scopeLabel="synthetic host"
        />
      )
    })
  }

  function input(): HTMLInputElement {
    const element = container.querySelector('input')
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('Expected credential input')
    }
    return element
  }

  function typeDraft(value = 'synthetic-unsaved-draft') {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (!setter) {
        throw new Error('Expected native input setter')
      }
      setter.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function snapshot(account: DeepSeekAccountStatus | undefined) {
    await act(async () => {
      publish({
        claude: {
          accounts: [],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: {} }
        },
        codex: {
          accounts: [],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: {} }
        },
        rateLimits: {
          claude: null,
          codex: null,
          gemini: null,
          opencodeGo: null,
          kimi: null,
          antigravity: null,
          minimax: null,
          grok: null,
          cursor: null,
          zcode: null,
          minimaxCookieConfigured: false,
          minimaxApiKeyConfigured: false,
          opencodeGoApiKeyConfigured: false,
          grokAuthConfigured: false,
          cursorAuthConfigured: false,
          claudeTarget: { runtime: 'host', wslDistro: null },
          codexTarget: { runtime: 'host', wslDistro: null },
          inactiveClaudeAccounts: [],
          inactiveCodexAccounts: [],
          deepseekAccount: account,
          deepseek: {
            provider: 'deepseek',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: null,
            status: 'ok'
          }
        }
      })
    })
  }

  function expectEmpty() {
    expect(input().value).toBe('')
    expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true)
  }

  it.each([
    ['replacement owner', status('owner-b')],
    ['missing account', undefined],
    ['unsupported account', status('owner-a', false)],
    ['null owner', status(null)],
    ['empty owner', status('')]
  ] as const)('discards a draft after %s and return to the original owner', async (_name, next) => {
    await render()
    typeDraft()
    expect(input().value).toBe('synthetic-unsaved-draft')
    await snapshot(next)
    await snapshot(status('owner-a'))
    expectEmpty()
  })

  it('retains current typing during ordinary same-owner balance updates', async () => {
    await render()
    typeDraft()
    await snapshot(status('owner-a'))
    expect(input().value).toBe('synthetic-unsaved-draft')
  })

  it('discards a draft across unsupported runtime and loading transitions', async () => {
    await render()
    typeDraft()
    await render('synthetic-host', true)
    await render()
    expectEmpty()
    typeDraft()
    const pending = deferred<DeepSeekAccountStatus>()
    backend.read.mockReturnValueOnce(pending.promise)
    await render('synthetic-second-host')
    expect(container.querySelector('input')).toBeNull()
    await act(async () => pending.resolve(status('owner-a')))
    expectEmpty()
  })

  it.each(['failure', 'stale status'] as const)(
    'clears before submission and drops late %s after owner replacement',
    async (outcome) => {
      const pending = deferred<DeepSeekAccountStatus>()
      backend.mutate.mockReturnValueOnce(pending.promise)
      await render()
      typeDraft()
      await act(async () => {
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(input().value).toBe('')
      expect(backend.mutate).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'synthetic-host' },
        'owner-a',
        'save',
        'synthetic-unsaved-draft'
      )
      await snapshot(status('owner-b'))
      typeDraft('synthetic-current-owner-draft')
      await act(async () => {
        if (outcome === 'failure') {
          pending.reject(new Error('synthetic failure'))
        } else {
          pending.resolve({ ...status('owner-a'), configured: true })
        }
      })
      expect(container.querySelector('[role="alert"]')).toBeNull()
      expect(input().value).toBe('synthetic-current-owner-draft')
      await snapshot(status('owner-a'))
      expectEmpty()
    }
  )

  it('clears a draft and closes the account watcher on hide and remount', async () => {
    await render()
    typeDraft()
    await act(async () => root.render(null))
    expect(close).toHaveBeenCalledOnce()
    await render()
    expectEmpty()
  })
})
