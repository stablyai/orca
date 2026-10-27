/** Forward publisher environment/selector so one host’s automation changes cannot invalidate every host. */

import { describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { AutomationsChangedWindowDetail } from '@/lib/automations-changed-window-event'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'

type ChangedListener = (payload: AutomationsChangedWindowDetail) => void

type Mounted = {
  /** Call inside the test body: useIpcEvents runs its effects eagerly there. */
  useIpcEvents: () => void
  emitRuntimeEvent: (environmentId: string, event: RuntimeClientEvent) => void
  emitDesktopChange: (payload: AutomationsChangedWindowDetail) => void
  details: () => AutomationsChangedWindowDetail[]
}

async function mountIpcEvents(): Promise<Mounted> {
  vi.resetModules()
  vi.unstubAllGlobals()
  let onRuntimeEvent: ((environmentId: string, event: RuntimeClientEvent) => void) | null = null
  let onDesktopChange: ChangedListener | null = null
  const dispatchEvent = vi.fn()

  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() }
  })
  vi.doMock('../store', () => ({
    useAppStore: {
      subscribe: vi.fn(() => () => {}),
      getState: () => ({
        settings: { activeRuntimeEnvironmentId: null },
        repos: [],
        worktreesByRepo: {},
        folderWorkspaces: [],
        projectGroups: [],
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        fetchRepos: vi.fn(() => Promise.resolve()),
        fetchProjectGroups: vi.fn(() => Promise.resolve()),
        fetchFolderWorkspaces: vi.fn(() => Promise.resolve())
      })
    }
  }))
  vi.doMock('./runtime-client-events-sync', () => ({
    createRuntimeClientEventsSync: (deps: {
      onEvent: (environmentId: string, event: RuntimeClientEvent) => void
    }) => {
      onRuntimeEvent = deps.onEvent
      return { sync: vi.fn(), stop: vi.fn() }
    }
  }))

  // Stub unrelated namespaces with pending promises so mount cannot reach unsupported store setters.
  const autoStubNamespace = new Proxy(
    {},
    {
      get:
        () =>
        (...args: unknown[]) =>
          typeof args[0] === 'function' ? () => {} : new Promise(() => {})
    }
  )
  const api = new Proxy(
    {
      automations: new Proxy(
        {
          onChanged: (listener: ChangedListener) => {
            onDesktopChange = listener
            return () => {}
          }
        } as Record<string, unknown>,
        { get: (target, prop: string) => target[prop] ?? autoStubNamespace[prop] }
      )
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] ?? autoStubNamespace }
  )
  vi.stubGlobal('window', {
    api,
    dispatchEvent,
    addEventListener: () => {},
    removeEventListener: () => {}
  })

  const { useIpcEvents } = await import('./useIpcEvents')

  return {
    useIpcEvents,
    emitRuntimeEvent: (environmentId, event) => {
      if (!onRuntimeEvent) {
        throw new Error('Expected the runtime client-event handler to be registered')
      }
      onRuntimeEvent(environmentId, event)
    },
    emitDesktopChange: (payload) => {
      if (!onDesktopChange) {
        throw new Error('Expected the desktop automations:changed listener to be registered')
      }
      onDesktopChange(payload)
    },
    details: () =>
      dispatchEvent.mock.calls
        .map(([event]) => event as CustomEvent<AutomationsChangedWindowDetail>)
        .filter((event) => event.type === AUTOMATIONS_CHANGED_EVENT)
        .map((event) => event.detail)
  }
}

describe('automationsChanged attribution through useIpcEvents', () => {
  it('carries the environment and selector of a runtime-published change', async () => {
    const { useIpcEvents, emitRuntimeEvent, details } = await mountIpcEvents()
    useIpcEvents()

    emitRuntimeEvent('env-1', {
      type: 'automationsChanged',
      selector: { kind: 'ssh', targetId: 'target-1' },
      reason: 'definition'
    })

    expect(details()).toEqual([
      {
        environmentId: 'env-1',
        selector: { kind: 'ssh', targetId: 'target-1' },
        reason: 'definition'
      }
    ])
  })

  it('still names the environment when an older host sends no selector', async () => {
    const { useIpcEvents, emitRuntimeEvent, details } = await mountIpcEvents()
    useIpcEvents()

    emitRuntimeEvent('env-2', { type: 'automationsChanged' })

    expect(details()).toEqual([{ environmentId: 'env-2' }])
  })

  it('forwards the desktop payload unchanged, so it stays the desktop authority', async () => {
    const { useIpcEvents, emitDesktopChange, details } = await mountIpcEvents()
    useIpcEvents()

    emitDesktopChange({ selector: { kind: 'self' }, reason: 'definition' })

    expect(details()).toEqual([{ selector: { kind: 'self' }, reason: 'definition' }])
  })
})
