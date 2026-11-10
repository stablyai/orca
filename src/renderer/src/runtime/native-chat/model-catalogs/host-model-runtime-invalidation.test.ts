// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { useAgentModelMenu } from '@/components/agent/launch-settings/use-agent-model-menu'
import { AgentChoiceControls } from '@/components/agent/launch-settings/AgentChoiceControls'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: transport.call
}))
const store = vi.hoisted(() => ({
  subscribe: vi.fn().mockReturnValue(() => {}),
  getState: vi.fn()
}))
vi.mock('@/store/index', () => ({ useAppStore: store }))
vi.mock('../local-sessions/local-structured-chats', () => ({
  localStructuredChatsInUse: async () => false
}))
vi.mock('../agent-catalogs/host-structured-agents', () => ({
  subscribeHostStructuredAgents: () => () => {}
}))
vi.mock('../../hosts/capabilities/local-runtime-capabilities', () => ({
  subscribeLocalRuntimeCapabilitiesKnown: () => () => {}
}))
import { installHostModelCatalogSnapshotsSync } from './host-model-catalog-snapshots-sync'
import {
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from './host-model-catalog-snapshots'

it('keeps closed Settings labels through a full settings fetch and a saved model choice', async () => {
  resetHostModelCatalogSnapshotsForTests()
  store.subscribe.mockClear()
  const initial = {
    settings: {
      agentDefaultEnv: { codex: {} },
      agentCmdOverrides: {},
      codexManagedAccounts: [],
      claudeManagedAccounts: []
    },
    runtimeStatusByEnvironmentId: new Map(),
    removedRuntimeEnvironmentIds: new Set<string>()
  }
  store.getState.mockReturnValue(initial)
  const stop = installHostModelCatalogSnapshotsSync()
  const changed = store.subscribe.mock.calls[0][0]
  const request = vi.fn()
  const source = {
    scope: { target: { kind: 'local' as const }, agent: 'codex' },
    coherentCatalog: true
  }
  function Editor({ model }: { model?: string }) {
    const value = model ? { model } : undefined
    const modelMenu = useAgentModelMenu('codex', value, source, false)
    return createElement(AgentChoiceControls, {
      agent: 'codex',
      value,
      modelMenu,
      layout: 'rows',
      onChange: () => {}
    })
  }
  const coldReply = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const coldRequest = vi.fn(() => coldReply.promise)
  const coldSource = {
    scope: {
      target: { kind: 'environment' as const, environmentId: 'without-preload' },
      agent: 'codex'
    },
    coherentCatalog: true
  }
  function Unpreloaded({ open }: { open: boolean }) {
    const value = { model: 'saved-unlisted' }
    const modelMenu = useAgentModelMenu('codex', value, coldSource, open)
    return createElement(AgentChoiceControls, {
      agent: 'codex',
      value,
      modelMenu,
      layout: 'rows',
      onChange: () => {}
    })
  }
  transport.call.mockImplementation((target) =>
    target.kind === 'environment' ? coldRequest() : request()
  )
  const cold = render(createElement(Unpreloaded, { open: false }))
  try {
    expect(
      screen.getByRole('button', { name: 'Model: saved-unlisted' }).getAttribute('aria-busy')
    ).toBe('false')
    expect(coldRequest).not.toHaveBeenCalled()
    cold.rerender(createElement(Unpreloaded, { open: true }))
    expect(
      screen.getByRole('button', { name: 'Model: saved-unlisted' }).getAttribute('aria-busy')
    ).toBe('true')
    await waitFor(() => expect(coldRequest).toHaveBeenCalledTimes(1))
  } finally {
    cold.unmount()
    await act(async () => {
      coldReply.resolve({ origin: 'unknown' })
      await coldReply.promise
    })
  }
  const view = render(createElement(Editor))
  try {
    expect(
      screen.getByRole('button', { name: 'Model: Agent default' }).getAttribute('aria-busy')
    ).toBe('false')
    act(() =>
      recordHostModelCatalogSnapshot(source.scope.target, 'codex', null, { origin: 'unknown' })
    )
    expect(
      screen.getByRole('button', { name: 'Model: Agent default' }).getAttribute('aria-busy')
    ).toBe('false')
    expect(screen.queryByRole('note')).toBeNull()
    act(() => {
      recordHostModelCatalogSnapshot(source.scope.target, 'codex', null, {
        origin: 'probe',
        fetchedAt: 1,
        modelsDifferByWorkspace: true,
        models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna', isDefault: false, efforts: [] }]
      })
    })
    expect(
      screen.getByRole('button', { name: 'Model: Agent default' }).getAttribute('aria-busy')
    ).toBe('false')
    const fetched = structuredClone(initial)
    act(() => changed(fetched, initial))
    expect(
      screen.getByRole('button', { name: 'Model: Agent default' }).getAttribute('aria-busy')
    ).toBe('false')
    const saved = {
      ...structuredClone(fetched),
      settings: {
        ...structuredClone(fetched.settings),
        agentLaunchChoices: { codex: { model: 'gpt-6-luna' } }
      }
    }
    act(() => changed(saved, fetched))
    view.rerender(createElement(Editor, { model: 'gpt-6-luna' }))
    expect(
      screen.getByRole('button', { name: 'Model: GPT-6-Luna' }).getAttribute('aria-busy')
    ).toBe('false')
    view.unmount()
    for (let i = 0; i < 2; i++) {
      const reopened = render(createElement(Editor, { model: 'gpt-6-luna' }))
      expect(
        screen.getByRole('button', { name: 'Model: GPT-6-Luna' }).getAttribute('aria-busy')
      ).toBe('false')
      reopened.unmount()
    }
    expect(request).not.toHaveBeenCalled()
  } finally {
    cleanup()
    stop()
  }
})
