// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UseBoundStore, StoreApi } from 'zustand'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { TERMINAL_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY } from '../../../../shared/terminal-runtime-capabilities'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PaneUsageLimitNotice } from './TerminalPaneUsageLimitPortals'

type State = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimeStatusByEnvironmentId: Map<string, { hostContactEpoch: number }>
  runtimeEnvironments: []
}
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create<State>(() => ({
      agentStatusByPaneKey: {},
      runtimeStatusByEnvironmentId: new Map(),
      runtimeEnvironments: []
    }))
  }
})
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-label', () => ({
  structuredAgentLabel: () => 'Codex'
}))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? '')
}))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies every field consumed by the production selector, capability hook and contact subscription.
const store = (await import('@/store')).useAppStore as unknown as UseBoundStore<StoreApi<State>>
const browserWindow = window
const target = { kind: 'environment', environmentId: 'owning-host' } as const
function quotaRow(): AgentStatusEntry {
  return {
    paneKey: 'quota',
    state: 'done',
    stateStartedAt: 20,
    updatedAt: 20,
    prompt: '',
    stateHistory: [],
    agentType: 'codex',
    terminalHandle: 'term_owned',
    providerSession: { id: 'session', key: 'session_id' },
    turnEndedAt: 20,
    turnEndDisposition: 'identified',
    mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 20, usageLimit: {} }
  }
}
function statusResponse(supported: boolean) {
  const response = createCompatibleRuntimeStatusResponse('runtime-owner')
  if (!supported) {
    response.result.capabilities = response.result.capabilities?.filter(
      (value) => value !== TERMINAL_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY
    )
  }
  return response
}
beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  store.setState({
    agentStatusByPaneKey: {},
    runtimeStatusByEnvironmentId: new Map(),
    runtimeEnvironments: []
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCacheForTests()
})

it.each([10, 100])(
  'does no upstream capability work for %i panes without a quota notice, on older or supported hosts',
  async (count) => {
    for (const supported of [false, true]) {
      const call = vi.fn(async () => statusResponse(supported))
      vi.stubGlobal('window', {
        document: browserWindow.document,
        setTimeout: browserWindow.setTimeout.bind(browserWindow),
        clearTimeout: browserWindow.clearTimeout.bind(browserWindow),
        api: { runtimeEnvironments: { call } }
      })
      const view = render(
        <TooltipProvider>
          {Array.from({ length: count }, (_, i) => (
            <PaneUsageLimitNotice key={i} paneKey={`pane-${i}`} target={target} />
          ))}
        </TooltipProvider>
      )
      await act(async () => {})
      expect(screen.queryByRole('region')).toBeNull()
      expect(call).not.toHaveBeenCalled()
      view.unmount()
      clearRuntimeCompatibilityCacheForTests()
    }
  }
)

it('observes an actual quota host, preserves ordinary legacy input and enables Continue after that host upgrades', async () => {
  let supported = false
  const call = vi.fn(async (request: { method: string }) =>
    request.method === 'status.get'
      ? statusResponse(supported)
      : { id: 'continue', ok: true, result: { status: 'input-accepted' } }
  )
  vi.stubGlobal('window', {
    document: browserWindow.document,
    setTimeout: browserWindow.setTimeout.bind(browserWindow),
    clearTimeout: browserWindow.clearTimeout.bind(browserWindow),
    api: { runtimeEnvironments: { call } }
  })
  store.setState({ agentStatusByPaneKey: { quota: quotaRow() } })
  render(
    <TooltipProvider>
      <PaneUsageLimitNotice paneKey="quota" target={target} />
    </TooltipProvider>
  )
  expect(screen.getByRole('button', { name: 'Continue now' }).hasAttribute('disabled')).toBe(true)
  await act(async () => {})
  expect(screen.queryByRole('button', { name: 'Continue now' })).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Send a message in the terminal')
  expect(call).toHaveBeenCalledTimes(1)
  supported = true
  await act(async () =>
    store.setState({
      runtimeStatusByEnvironmentId: new Map([['owning-host', { hostContactEpoch: 1 }]])
    })
  )
  expect(call).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button', { name: 'Continue now' }).hasAttribute('disabled')).toBe(false)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue now' })))
  expect(
    call.mock.calls.filter(([request]) => request.method === 'terminal.continueAfterUsageLimit')
  ).toHaveLength(1)
  expect(screen.getByRole('status').textContent).toContain('Continue was sent to Codex')
})
