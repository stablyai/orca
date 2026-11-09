import {
  useAgentPickerSetup,
  useAgentPickerDraftScope
} from '../../../../components/agent/agent-launch-picker-drafts'
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { AgentLaunchSetupPanel } from '../../../../components/agent/AgentLaunchSetupPanel'
import { TooltipProvider } from '../../../../components/ui/tooltip'
import { useAgentLaunchPickerInventorySource } from '../../../../components/agent/use-agent-launch-picker-inventory'
import { useAgentPickerInventoryEntries } from '../../../../components/agent/agent-launch-picker-acquisition'
import type { NewTabAgentMenuModel } from '../../../../components/tab-bar/new-tab-agent-menu-model'

import {
  store,
  mockCreateWebRuntimeSessionTerminal,
  mockIsWebRuntimeSessionActive
} from './launch-agent-in-new-tab-test-fixture'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const inventory = vi.hoisted(() => ({ settings: vi.fn(), legacy: vi.fn(), session: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (...args: unknown[]) =>
    args[1] === 'settings.getAgentLaunch'
      ? { settings: await inventory.settings(...args) }
      : inventory.legacy(...args)
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true,
  runtimeEnvironmentSupportsCapabilities: async () => [false, false]
}))
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: inventory.session
}))

it('keeps pristine, edited and reopened historical-host picker launches free of desktop defaults', async () => {
  const operation =
    await import('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation')
  vi.spyOn(operation, 'createWebRuntimeSessionTerminalResult').mockImplementation(
    async ({ legacyAgentLaunch, ...request }) => ({
      outcome: await mockCreateWebRuntimeSessionTerminal({
        ...request,
        ...(request.preparedAgentCommand ? await legacyAgentLaunch?.() : {})
      })
    })
  )
  const { useTabAgentMenuLaunch } = await import('../../../../components/tab-bar/QuickLaunchButton')
  const snapshot = {
    defaultTuiAgent: 'claude',
    disabledTuiAgents: [],
    agentCmdOverrides: { claude: '/host/claude' },
    agentDefaultArgs: { claude: '--permission-mode auto' },
    environmentNames: {},
    permissionMode: 'mixed' as const
  }
  Object.assign(store.settings, {
    agentCmdOverrides: { claude: '/desktop/claude' },
    agentDefaultArgs: { claude: '--model desktop-only-qa' },
    agentLaunchChoices: { claude: { model: 'desktop-only-qa' } },
    activeRuntimeEnvironmentId: 'web-runtime'
  })
  Object.assign(store.repos[0], { executionHostId: 'runtime:web-runtime' })
  mockIsWebRuntimeSessionActive.mockReturnValue(true)
  inventory.settings.mockResolvedValue(snapshot)
  inventory.session.mockResolvedValue({ origin: 'unknown' })
  const row = { agent: 'claude', kind: 'cli', executionHostId: 'runtime:web-runtime' } as const
  const menu: NewTabAgentMenuModel = {
    state: 'settled',
    rows: [row],
    defaultTuiAgent: 'claude',
    detection: {
      detectedIds: ['claude'],
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => ['claude']
    },
    pickerContext: {
      workspace: { kind: 'git-worktree', worktreeId: 'wt-1' },
      executionHostId: row.executionHostId,
      key: 'qa-history-host',
      settings: null
    }
  }
  function Panel({ open }: { open: boolean }) {
    const entry = useAgentPickerInventoryEntries(
      useAgentLaunchPickerInventorySource('wt-1', menu, open)
    )[0]
    const draftScope = useAgentPickerDraftScope()
    const setup = useAgentPickerSetup({ entry, draftScope, open })
    const launch = useTabAgentMenuLaunch({
      worktreeId: 'wt-1',
      groupId: 'group-1',
      onFocusTerminal: () => {}
    })
    return open && setup.ready
      ? createElement(
          TooltipProvider,
          null,
          // Select mode still edits Arguments and Permissions; the launch menu leaves them to settings.
          createElement(AgentLaunchSetupPanel, {
            entry,
            mode: 'select',
            draft: setup.draft,
            getDraft: setup.getDraft,
            onDraftChange: setup.change,
            onUse: (draft) => {
              if (setup.accept(draft)) {
                launch(row, draft, entry)
              }
            }
          })
        )
      : null
  }
  const view = render(createElement(Panel, { open: true }))
  await act(async () => {})
  async function start() {
    mockCreateWebRuntimeSessionTerminal.mockClear()
    fireEvent.click(view.getByText('Launch terminal'))
    await act(async () => {})
    const request = mockCreateWebRuntimeSessionTerminal.mock.calls[0]?.[0]
    expect(request).toBeDefined()
    expect(JSON.stringify(request)).not.toContain('desktop-only-qa')
    expect(request).not.toHaveProperty('command')
    return request!
  }
  const pristine = await start()
  expect(pristine).not.toHaveProperty('agentArgs')
  view.rerender(createElement(Panel, { open: false }))
  view.rerender(createElement(Panel, { open: true }))
  await act(async () => {})
  if (!view.queryByLabelText('Arguments')) {
    fireEvent.click(view.getByLabelText('Toggle Arguments'))
  }
  fireEvent.change(view.getByLabelText('Arguments'), { target: { value: '--add-dir /tmp' } })
  const edited = await start()
  expect(edited.agentArgs).toBe('--permission-mode auto --add-dir /tmp')
  view.rerender(createElement(Panel, { open: false }))
  view.rerender(createElement(Panel, { open: true }))
  await act(async () => {})
  const reopened = await start()
  expect(reopened.agentArgs).toBe('--permission-mode auto --add-dir /tmp')
})
