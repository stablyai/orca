import { describe, expect, it, vi } from 'vitest'

const focusGroup = vi.hoisted(() => vi.fn())
const dismissAddressBarSuggestions = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {
        'wt-1': [{ contentType: 'browser', entityId: 'workspace-1', groupId: 'group-9' }]
      },
      focusGroup
    })
  }
}))

type Listener = () => void

function fakeWebview(): {
  listeners: Map<string, Set<Listener>>
  addEventListener(type: 'focus', listener: Listener): void
  removeEventListener(type: 'focus', listener: Listener): void
} {
  const listeners = new Map<string, Set<Listener>>()
  return {
    listeners,
    addEventListener(type: 'focus', listener: Listener) {
      const bucket = listeners.get(type) ?? new Set()
      bucket.add(listener)
      listeners.set(type, bucket)
    },
    removeEventListener(type: 'focus', listener: Listener) {
      listeners.get(type)?.delete(listener)
    }
  }
}

describe('bindBrowserGuestFocus', () => {
  it('focuses the workspace tab and removes that same callback on cleanup', async () => {
    const { bindBrowserGuestFocus } = await import('./bind-browser-page-webview-listeners')
    const webview = fakeWebview()
    const cleanup = bindBrowserGuestFocus({
      webview,
      dismissAddressBarSuggestions,
      worktreeId: 'wt-1',
      workspaceId: 'workspace-1'
    })

    const focusListeners = webview.listeners.get('focus')
    expect(focusListeners?.size).toBe(1)
    focusListeners?.forEach((listener) => listener())
    expect(dismissAddressBarSuggestions).toHaveBeenCalledTimes(1)
    expect(focusGroup).toHaveBeenCalledWith('wt-1', 'group-9')

    cleanup()
    expect(webview.listeners.get('focus')?.size ?? 0).toBe(0)
  })
})
