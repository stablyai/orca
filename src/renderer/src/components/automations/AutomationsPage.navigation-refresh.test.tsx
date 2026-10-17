// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { Automation } from '../../../../shared/automations-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { AUTOMATIONS_CHANGED_EVENT } from '@/lib/automations-changed-window-event'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  publishStoreChanges,
  renderPage,
  runtimeHost
} from './automations-page-test-harness'
import { makeAutomation } from './automations-page-fixtures'
import AutomationsPage from './AutomationsPage'

installAutomationsPageHarness()

type DeferredListRead = {
  target: RuntimeClientTarget
  resolve: (result: { automations: Automation[] }) => void
  reject: (error: Error) => void
}

function installDeferredListReads() {
  const automation = makeAutomation({ id: 'a-1' })
  runtimeHost([automation], [])
  mocks.state.setSelectedAutomationId = (value: string | null) => {
    mocks.state.selectedAutomationId = value
  }
  const calls: DeferredListRead[] = []
  const original = mocks.callRuntimeRpc.getMockImplementation()
  if (!original) {
    throw new Error('The page harness must install its RPC handler.')
  }
  mocks.callRuntimeRpc.mockImplementation(
    (target: RuntimeClientTarget, method: string, params?: unknown) => {
      const scoped = params !== null && typeof params === 'object' && 'selector' in params
      if (method === 'automation.list' && !scoped) {
        return new Promise<{ automations: Automation[] }>((resolve, reject) =>
          calls.push({ target, resolve, reject })
        )
      }
      return original(target, method, params)
    }
  )
  mocks.state.setPendingAutomationRunNavigation = mocks.setPendingRunNavigation
  mocks.setPendingRunNavigation.mockImplementation((value: unknown) => {
    mocks.state.pendingAutomationRunNavigation = value
  })
  return { automation, calls }
}

function pendingNavigation(hostId = 'runtime:gpu') {
  return { automationId: 'a-1', runId: null, hostId }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

it('settles a failed navigation read without opening another list or external-manager read', async () => {
  const { automation, calls } = installDeferredListReads()
  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  const { rerender } = await renderPage()
  expect(calls).toHaveLength(1)
  const externalReads = api.automations.listExternalManagerForOwner.mock.calls.length

  await act(async () => calls[0].reject(new Error('GPU box is not connected')))
  for (let index = 0; index < 10; index += 1) {
    await flushEffects()
  }

  expect(calls).toHaveLength(1)
  expect(api.automations.listExternalManagerForOwner).toHaveBeenCalledTimes(externalReads)
  expect(mocks.setPendingRunNavigation).not.toHaveBeenCalled()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(calls).toHaveLength(2)
  expect(api.automations.listExternalManagerForOwner.mock.calls.length).toBeGreaterThan(
    externalReads
  )
  await act(async () => calls[1].resolve({ automations: [automation] }))
  await rerender()
  expect(calls).toHaveLength(2)
  expect(mocks.setPendingRunNavigation).toHaveBeenCalledWith(null)
})

it('gives new same-host navigation and another host their own attempts', async () => {
  const { automation, calls } = installDeferredListReads()
  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  const { rerender } = await renderPage()
  await act(async () => calls[0].reject(new Error('offline')))

  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  await rerender()
  expect(calls).toHaveLength(2)
  await act(async () => calls[1].reject(new Error('offline')))
  mocks.state.pendingAutomationRunNavigation = pendingNavigation('runtime:other')
  await rerender()
  expect(calls).toHaveLength(3)
  expect(calls[2].target).toEqual({ kind: 'environment', environmentId: 'other' })
  await act(async () => calls[2].resolve({ automations: [automation] }))
  await rerender()
  expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
})

it('clearing navigation stops a late failure and permits reentry with the same object', async () => {
  const { calls } = installDeferredListReads()
  const navigation = pendingNavigation()
  mocks.state.pendingAutomationRunNavigation = navigation
  const { rerender } = await renderPage()
  mocks.state.pendingAutomationRunNavigation = null
  await rerender()
  await act(async () => calls[0].reject(new Error('offline')))
  expect(calls).toHaveLength(1)

  mocks.state.pendingAutomationRunNavigation = navigation
  await rerender()
  expect(calls).toHaveLength(2)
  mocks.state.pendingAutomationRunNavigation = null
  await rerender()
  await act(async () => calls[1].reject(new Error('offline')))
})

it('keeps local failures bounded and explicit focus refresh on the local host', async () => {
  const { calls } = installDeferredListReads()
  const { rerender } = await renderPage()
  expect(calls[0].target).toEqual({ kind: 'local' })
  await act(async () => calls[0].reject(new Error('local read failed')))
  await flushEffects()
  expect(calls).toHaveLength(1)

  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(calls).toHaveLength(2)
  expect(calls[1].target).toEqual({ kind: 'local' })
  await act(async () => calls[1].resolve({ automations: [] }))
  await rerender()
  expect(calls).toHaveLength(2)
})

it('opens no further requests when a failed read settles after the page unmounts', async () => {
  const { calls } = installDeferredListReads()
  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(AutomationsPage)))
    expect(calls).toHaveLength(1)
    await act(async () => root.unmount())
    const externalReads = api.automations.listExternalManagerForOwner.mock.calls.length
    mocks.state.runtimeStatusByEnvironmentId = new Map([
      ['gpu', runtimeContact({ hostContactEpoch: 1 })]
    ])
    await act(async () => publishStoreChanges())
    await act(async () => calls[0].reject(new Error('offline')))
    await flushEffects()
    expect(calls).toHaveLength(1)
    expect(api.automations.listExternalManagerForOwner).toHaveBeenCalledTimes(externalReads)
  } finally {
    await act(async () => root.unmount())
  }
})

it('attempts the new navigation host after the preceding pending read settles', async () => {
  const { calls } = installDeferredListReads()
  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  const { rerender } = await renderPage()
  mocks.state.pendingAutomationRunNavigation = pendingNavigation('runtime:other')
  await rerender()
  expect(calls).toHaveLength(1)

  await act(async () => calls[0].reject(new Error('GPU box offline')))
  expect(calls).toHaveLength(2)
  expect(calls[1].target).toEqual({ kind: 'environment', environmentId: 'other' })
  mocks.state.pendingAutomationRunNavigation = null
  await rerender()
  await act(async () => calls[1].reject(new Error('other offline')))
})

it('allows an automation change event to retry a failed navigation read', async () => {
  const { calls } = installDeferredListReads()
  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  const { rerender } = await renderPage()
  await act(async () => calls[0].reject(new Error('offline')))
  expect(calls).toHaveLength(1)

  await act(async () => window.dispatchEvent(new Event(AUTOMATIONS_CHANGED_EVENT)))
  expect(calls).toHaveLength(2)
  mocks.state.pendingAutomationRunNavigation = null
  await rerender()
  await act(async () => calls[1].reject(new Error('offline')))
})

function runtimeContact(
  overrides: Partial<RuntimeEnvironmentStatus> = {}
): RuntimeEnvironmentStatus {
  return {
    checkedAt: 1,
    connectionGeneration: 0,
    hostContactEpoch: 0,
    status: {
      runtimeId: 'gpu-1',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    },
    ...overrides
  }
}

it('retries the focused navigation only when its host regains contact, not on status polls or other hosts', async () => {
  const { automation, calls } = installDeferredListReads()
  const connected = runtimeContact()
  mocks.state.runtimeStatusByEnvironmentId = new Map([['gpu', connected]])
  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  const { rerender } = await renderPage()
  await act(async () => calls[0].reject(new Error('offline')))

  mocks.state.runtimeStatusByEnvironmentId = new Map([
    ['gpu', { ...connected, checkedAt: 2 }],
    ['other', runtimeContact({ hostContactEpoch: 99, connectionGeneration: 99 })]
  ])
  await rerender()
  expect(calls).toHaveLength(1)
  mocks.state.runtimeStatusByEnvironmentId = new Map([
    ['gpu', { ...connected, connectionGeneration: 1, status: null }]
  ])
  await rerender()
  expect(calls).toHaveLength(1)

  mocks.state.runtimeStatusByEnvironmentId = new Map([
    ['gpu', { ...connected, connectionGeneration: 1, hostContactEpoch: 1 }]
  ])
  await rerender()
  expect(calls).toHaveLength(2)
  expect(calls[1].target).toEqual({ kind: 'environment', environmentId: 'gpu' })
  await act(async () => calls[1].resolve({ automations: [automation] }))
  await rerender()
  expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
})

it.each([
  ['first contact', undefined, runtimeContact()],
  ['runtime restart', runtimeContact(), runtimeContact({ connectionGeneration: 1 })]
])('allows one navigation retry after %s', async (_label, previous, next) => {
  const { calls } = installDeferredListReads()
  mocks.state.runtimeStatusByEnvironmentId = previous ? new Map([['gpu', previous]]) : new Map()
  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  const { rerender } = await renderPage()
  await act(async () => calls[0].reject(new Error('offline')))
  expect(calls).toHaveLength(1)

  mocks.state.runtimeStatusByEnvironmentId = new Map([['gpu', next]])
  await rerender()
  expect(calls).toHaveLength(2)
  await act(async () => calls[1].reject(new Error('list still failed')))
  await flushEffects()
  expect(calls).toHaveLength(2)
})

it('waits for the preceding request before retrying a host recovered during that request', async () => {
  const { calls } = installDeferredListReads()
  mocks.state.runtimeStatusByEnvironmentId = new Map([['gpu', runtimeContact()]])
  mocks.state.pendingAutomationRunNavigation = pendingNavigation()
  const { rerender } = await renderPage()
  mocks.state.runtimeStatusByEnvironmentId = new Map([
    ['gpu', runtimeContact({ hostContactEpoch: 1 })]
  ])
  await rerender()
  expect(calls).toHaveLength(1)
  await act(async () => calls[0].reject(new Error('old connection failed')))
  expect(calls).toHaveLength(2)
  await act(async () => calls[1].reject(new Error('list failed')))
  await flushEffects()
  expect(calls).toHaveLength(2)
})
