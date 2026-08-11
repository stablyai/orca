import { describe, expect, it, vi } from 'vitest'

type StoreState = { settings: { uiLanguage: string } | null }

const storeFixture = vi.hoisted(() => {
  const listeners = new Set<(state: StoreState) => void>()
  const store = {
    state: { settings: null } as StoreState,
    setState(next: StoreState) {
      store.state = next
      for (const listener of listeners) {
        listener(next)
      }
    },
    getState: () => store.state,
    subscribe(listener: (state: StoreState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return store
})

const nlsLoads = vi.hoisted(() => ({ zh: 0 }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: storeFixture.getState,
    subscribe: storeFixture.subscribe
  }
}))

vi.mock('@/i18n/i18n', () => ({ i18n: { language: 'en' } }))

vi.mock('monaco-editor/esm/nls.messages.zh-cn.js', () => {
  nlsLoads.zh += 1
  ;(globalThis as Record<string, unknown>)._VSCODE_NLS_MESSAGES = ['zh-test']
  return {}
})

describe('monacoNlsBootstrap', () => {
  // Fresh renderer with uiLanguage 'zh': i18n boots in 'en' and settings arrive
  // async over IPC — the bootstrap must wait for them, load the zh NLS pack
  // before resolving, and hand every caller the same promise.
  it('waits for late-arriving zh settings and loads the NLS pack exactly once', async () => {
    const { monacoNlsBootstrap } = await import('./monaco-nls')

    const first = monacoNlsBootstrap()
    const second = monacoNlsBootstrap()
    expect(nlsLoads.zh).toBe(0)

    storeFixture.setState({ settings: { uiLanguage: 'zh' } })
    await Promise.all([first, second])

    expect(nlsLoads.zh).toBe(1)
    expect((globalThis as Record<string, unknown>)._VSCODE_NLS_MESSAGES).toEqual(['zh-test'])

    // Later callers reuse the settled bootstrap without reloading the pack.
    await monacoNlsBootstrap()
    expect(nlsLoads.zh).toBe(1)
  })
})
