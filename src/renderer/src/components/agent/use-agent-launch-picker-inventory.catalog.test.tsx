// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  inventoryModel as model,
  inventoryCatalog as catalog
} from './agent-launch-picker-freshness-test-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as picker from '../../../../shared/agent-launch-picker'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type { NewTabAgentMenuModel } from '../tab-bar/new-tab-agent-menu-model'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { useAgentPickerDraftScope, useAgentPickerSetup } from './agent-launch-picker-drafts'
import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  rpc: vi.fn(),
  session: vi.fn(),
  store: { repos: [{ id: 'repo-prospective', path: '/host/repo' }] }
}))
vi.mock('../settings/agent-launch-settings-transport', () => ({
  readHostAgentLaunchSettings: mocks.settings
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ settings: { agentDefaultArgs: { codex: '--desktop-only' } } }),
    { getState: () => mocks.store }
  )
}))
vi.mock('@/lib/agent-launch-route-input', () => ({
  buildAgentLaunchRouteInput: () => ({ executionHostId: 'local' }),
  workspaceKindForWorktreeId: () => 'git-worktree'
}))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: (host: string) =>
    host.startsWith('runtime:')
      ? { kind: 'environment', environmentId: host.slice(8) }
      : host === 'local'
        ? { kind: 'local' }
        : null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.session
}))

beforeEach(() => {
  mocks.settings.mockReset().mockResolvedValue(
    projectAgentLaunchSettings({
      agentPermissionDefault: 'ask',
      agentDefaultArgs: { codex: '--host-only' }
    })
  )
  mocks.rpc.mockReset()
  mocks.session
    .mockReset()
    .mockImplementation(async (_target, method) =>
      method === 'agentSession.modelCatalog'
        ? catalog
        : { seedOptions: { model: 'host-model', effort: 'low', permissionMode: 'full-access' } }
    )
})
afterEach(cleanup)
afterEach(resetHostStructuredAgentsForTests)

function CatalogBoundaryPanel({
  menu,
  onUse
}: {
  menu: Extract<NewTabAgentMenuModel, { state: 'settled' }>
  onUse: (draft: picker.AgentPickerDraft, entry: picker.AgentPickerEntry) => void
}) {
  const [entry] = useAgentLaunchPickerInventory('wt', menu, true)
  const draftScope = useAgentPickerDraftScope()
  const setup = useAgentPickerSetup({ entry, draftScope, open: true })
  return setup.ready
    ? createElement(
        TooltipProvider,
        null,
        createElement(AgentLaunchSetupPanel, {
          entry,
          draft: setup.draft,
          getDraft: setup.getDraft,
          onDraftChange: setup.change,
          onUse: (draft) => onUse(draft, entry)
        })
      )
    : null
}

it('shows unsupported rather than perpetual busy for a null-target SSH catalog without changing Arguments or launch', () => {
  const menu = model('ssh-no-channel', ['pi'])
  menu.pickerContext!.executionHostId = 'ssh:plain'
  menu.pickerContext!.settings = {
    agentDefaultArgs: { pi: '--debug' },
    agentPermissionDefault: 'ask'
  }
  menu.rows = [{ kind: 'cli', agent: 'pi', executionHostId: 'ssh:plain' }]
  const onUse = vi.fn()
  const view = render(createElement(CatalogBoundaryPanel, { menu, onUse }))
  const input = view.getByLabelText('Search models')
  expect(input).toHaveProperty('disabled', false)
  expect(input.getAttribute('aria-busy')).toBe('false')
  expect(view.getByRole('status').textContent).toContain('Pi models are unavailable on this host.')
  expect(view.container.querySelector('textarea')).toHaveProperty('value', '--debug')
  expect(mocks.session).not.toHaveBeenCalled()
  expect(mocks.settings).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Launch terminal' }))
  expect(onUse).toHaveBeenCalledOnce()
  expect(onUse.mock.calls[0][0]).toMatchObject({ agent: 'pi', surface: 'terminal' })
  const [draft, entry] = onUse.mock.calls[0]
  expect(entry.arguments).toBe('--debug')
  expect(draft.arguments).toBeUndefined()
  expect(picker.agentPickerLaunchInputs(draft, entry)).not.toHaveProperty('agentArgs')
  expect(picker.agentPickerArgumentsText(entry, draft)).toBe('--debug')
})

it('uses the existing known host registration to show no-discovery without a futile catalog retry', async () => {
  mocks.rpc.mockResolvedValueOnce({ agents: [{ agent: 'pi', capabilities: {} }] })
  await loadHostStructuredAgents(
    'runtime:no-discovery',
    [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
    'process-no-discovery'
  )
  const menu = model('no-discovery', ['aider'])
  menu.rows = [{ kind: 'cli', agent: 'aider', executionHostId: 'runtime:no-discovery' }]
  const onUse = vi.fn()
  const mount = () => render(createElement(CatalogBoundaryPanel, { menu, onUse }))
  let view = mount()
  await act(async () => {})
  const assertAvailable = () => {
    expect(view.getByLabelText('Search models')).toHaveProperty('disabled', false)
    expect(view.getByRole('status').textContent).toContain(
      'Aider models are unavailable on this host.'
    )
    expect(view.container.textContent).not.toContain('Close and reopen')
    expect(view.getByRole('button', { name: 'Launch terminal' })).toHaveProperty('disabled', false)
  }
  assertAvailable()
  view.unmount()
  view = mount()
  await act(async () => {})
  assertAvailable()
  expect(
    mocks.session.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog')
  ).toHaveLength(0)
  fireEvent.click(view.getByRole('button', { name: 'Launch terminal' }))
  expect(onUse).toHaveBeenCalledOnce()
  expect(onUse.mock.calls[0][0]).toMatchObject({ agent: 'aider', surface: 'terminal' })
})

it('does not mark a skipped no-surface entry busy or queue a catalog on reopen', async () => {
  const menu = model('no-surface', ['pi'])
  menu.rows = [{ kind: 'chat-unavailable', agent: 'pi', reason: 'not-on-host' }]
  menu.detection.detectedIds = []
  const { result, rerender } = renderHook(
    ({ open }) => useAgentLaunchPickerInventory('wt', menu, open),
    { initialProps: { open: true } }
  )
  await act(async () => {})
  expect(result.current[0]).toMatchObject({ surfaces: [], catalogRead: 'unsupported' })
  rerender({ open: false })
  rerender({ open: true })
  await act(async () => {})
  expect(result.current[0]).toMatchObject({ surfaces: [], catalogRead: 'unsupported' })
  expect(
    mocks.session.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog')
  ).toHaveLength(0)
})
