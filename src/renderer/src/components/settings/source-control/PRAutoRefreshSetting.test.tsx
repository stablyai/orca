// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import {
  _resetPRAutoRefreshCadencesForTests,
  setPRAutoRefreshCadenceForHost
} from '../../../../../shared/review-refresh-policy'
import { _resetHostPRAutoRefreshCadenceGenerationsForTests } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence'

const rpc = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  callRuntimeRpc: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc.callRuntimeRpc }))
vi.mock('@/store/retained-views/app-state-view', () => ({
  useAppStateValue: (selector: (state: unknown) => unknown) =>
    selector({
      settingsSearchQuery: '',
      runtimeEnvironments: [
        { id: 'env-a', name: 'Boston build server' },
        { id: 'env-b', name: 'Lab box' }
      ]
    })
}))
vi.mock('@/store/index', async () => {
  const { useStore } = await import('zustand')
  const { createStore } = await import('zustand/vanilla')
  const store = createStore(() => ({ settingsSearchQuery: '' }))
  return {
    useAppStore: Object.assign((select: (s: unknown) => unknown) => useStore(store, select), store)
  }
})
import { PRAutoRefreshSetting } from './PRAutoRefreshSetting'

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  await i18n.changeLanguage('en')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  rpc.settings.clear()
  rpc.callRuntimeRpc
    .mockReset()
    .mockImplementation(
      async (
        target: { environmentId: string },
        method: string,
        params?: { prAutoRefresh?: string }
      ) => {
        if (method === 'settings.update' && params?.prAutoRefresh) {
          rpc.settings.set(target.environmentId, params.prAutoRefresh)
        }
        return { settings: { prAutoRefresh: rpc.settings.get(target.environmentId) ?? 'default' } }
      }
    )
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  _resetPRAutoRefreshCadencesForTests()
  _resetHostPRAutoRefreshCadenceGenerationsForTests()
})

function option(label: string): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
  ).find((candidate) => candidate.textContent === label)
  if (!button) {
    throw new Error(`No ${label} option`)
  }
  return button
}
function selected(): string | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find(
      (button) => button.getAttribute('aria-checked') === 'true'
    )?.textContent ?? null
  )
}
function hint(): string | null {
  return container.querySelector('[data-testid="pr-auto-refresh-hint"]')?.textContent ?? null
}
async function mount(environmentId: string): Promise<void> {
  await act(async () =>
    root.render(
      <PRAutoRefreshSetting
        hostScope={{ target: { kind: 'environment', environmentId }, available: true }}
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a remote host never reads the local settings.
        settings={{} as never}
        updateSettings={() => {}}
      />
    )
  )
  await act(async () => {})
}

describe('PRAutoRefreshSetting for a paired host', () => {
  it('shows the host’s current setting after another client changes it', async () => {
    rpc.settings.set('env-a', 'default')
    await mount('env-a')
    expect(selected()).toBe('Default')

    // The host's settingsChanged read (or another window's control) remembers the new value.
    await act(async () => {
      setPRAutoRefreshCadenceForHost('env-a', 'off')
    })
    expect(selected()).toBe('Off')
    expect(hint()).toContain('Off: no timed refresh.')
  })

  it('lets the user choose Default back after another client picked Off', async () => {
    rpc.settings.set('env-a', 'default')
    await mount('env-a')
    await act(async () => {
      setPRAutoRefreshCadenceForHost('env-a', 'off')
    })
    await act(async () => option('Default').click())
    await act(async () => {})
    expect(rpc.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-a' },
      'settings.update',
      { prAutoRefresh: 'default' },
      expect.anything()
    )
    expect(selected()).toBe('Default')
  })

  it('shows a value the host sync already knows without waiting for its own read', async () => {
    let answer!: (value: { settings: { prAutoRefresh: string } }) => void
    rpc.callRuntimeRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    setPRAutoRefreshCadenceForHost('env-a', 'minimal')
    await mount('env-a')
    expect(selected()).toBe('Minimal')
    await act(async () => {
      answer({ settings: { prAutoRefresh: 'reduced' } })
    })
    expect(selected()).toBe('Reduced')
  })

  it('reads the setting of the host Settings switched to, and keeps each host’s own value', async () => {
    rpc.settings.set('env-a', 'off')
    rpc.settings.set('env-b', 'reduced')
    await mount('env-a')
    expect(selected()).toBe('Off')
    await mount('env-b')
    expect(selected()).toBe('Reduced')
    await mount('env-a')
    expect(selected()).toBe('Off')
  })

  it('falls back to Default with a clear hint when the host is an older Orca without the setting', async () => {
    // An older host's settings.get carries no prAutoRefresh key.
    rpc.callRuntimeRpc.mockImplementation(async () => ({ settings: {} }))
    await mount('env-a')
    expect(selected()).toBe('Default')
    expect(hint()).toBe(
      'Boston build server runs an older Orca without this setting, so it refreshes at Default. Update Orca on that server to change it.'
    )
    for (const button of container.querySelectorAll('button[role="radio"]')) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
    }
    // Nothing is written to a host that would reject the key.
    await act(async () => option('Off').click())
    expect(rpc.callRuntimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'settings.update',
      expect.anything(),
      expect.anything()
    )
  })
})
