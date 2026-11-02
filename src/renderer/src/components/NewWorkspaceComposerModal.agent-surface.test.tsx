// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NewWorkspaceComposerCardProps } from './new-workspace/new-workspace-composer-card-props'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import type { HostStructuredAgentAvailability } from '@/runtime/host-structured-agent-availability'
import { TooltipProvider } from '@/components/ui/tooltip'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import NewWorkspaceComposerModal from './NewWorkspaceComposerModal'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  host: 'local',
  availability: vi.fn<() => HostStructuredAgentAvailability>()
}))
vi.mock('@/runtime/use-host-structured-agent-availability', () => ({
  useHostStructuredAgentAvailability: mocks.availability
}))
vi.mock('@/components/agent/AgentSettingsDialog', () => ({ default: () => null }))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'opencode'],
    isLoading: false,
    detectionFailed: false,
    needsServerUpdate: false
  })
}))
vi.mock('@/hooks/useComposerState', () => ({
  useComposerState: () => ({
    cardProps: {
      projectOptions: [],
      selectedRepoIsGit: true,
      detectedAgentIds: new Set(['claude', 'opencode']),
      agentRows: {
        target: { workspace: { kind: 'git-worktree', executionHostId: mocks.host } },
        detectionTarget: { kind: 'local' }
      }
    },
    composerRef: useRef(null),
    submitQuick: mocks.submit,
    createDisabled: false
  })
}))
// Keep the actual owner/handler and picker; unrelated project/name fields are outside this seam.
vi.mock('@/components/NewWorkspaceComposerCard', () => ({
  default: (p: NewWorkspaceComposerCardProps) => (
    <div ref={p.composerRef}>
      <AgentCombobox
        agents={AGENT_CATALOG}
        value={p.quickAgent}
        onValueChange={p.onQuickAgentChange}
        allowBlankTerminal
        surfaceRows={p.agentSurfaceRows}
      />
      <button onClick={p.onCreate} disabled={p.createDisabled}>
        Create
      </button>
      <button onClick={() => p.onQuickAgentChange(null)}>Blank</button>
      <button onClick={p.onQuickSetupOnlySelect}>Setup only</button>
      <button onClick={() => p.onQuickAgentChange('claude', 'terminal')}>Choose CLI</button>
      <button onClick={() => p.onQuickAgentChange('claude', 'chat')}>Choose chat</button>
    </div>
  )
}))
const initial = useAppStore.getState()
beforeEach(() => {
  mocks.submit.mockReset()
  mocks.host = 'local'
  mocks.availability.mockReturnValue({ state: 'pending' })
  setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
  useAppStore.setState({
    activeModal: 'new-workspace-composer',
    modalData: {},
    settings: {
      ...getDefaultSettings('/test'),
      nativeChatProviders: EVERY_AGENT_CHAT,
      defaultTuiAgent: 'claude'
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})
const create = () => screen.getByRole('button', { name: 'Create' })
const submit = async () => {
  await act(async () => fireEvent.click(create()))
}

it.each(['chat', 'terminal'] as const)(
  'gates explicit selections over default %s, preserves terminal and blank exceptions, and repairs host changes',
  async (agentDefaultSurface) => {
    setLocalRuntimeCapabilitiesForTests(null)
    const view = render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
    expect(create().hasAttribute('disabled')).toBe(true)
    await submit()
    fireEvent.keyDown(create(), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(create(), { key: 'Enter', metaKey: true })
    expect(mocks.submit).not.toHaveBeenCalled()
    act(() => setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES))
    fireEvent.click(screen.getByText('Blank'))
    await submit()
    expect(mocks.submit).toHaveBeenLastCalledWith(
      null,
      expect.objectContaining({ setupOnly: false })
    )
    fireEvent.click(screen.getByText('Setup only'))
    await submit()
    expect(mocks.submit).toHaveBeenLastCalledWith(
      null,
      expect.objectContaining({ setupOnly: true })
    )
    fireEvent.click(screen.getByText('Choose CLI'))
    expect(screen.getByRole('combobox').textContent).toContain('Claude (CLI)')
    await submit()
    expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
      route: 'terminal-tui',
      requestedSurface: 'terminal'
    })
    mocks.availability.mockReturnValue({
      state: 'received',
      byAgent: new Map([['claude', { agent: 'claude', state: 'available' }]])
    })
    fireEvent.click(screen.getByText('Choose chat'))
    // Another window changes the default/override after the user explicitly picked Chat.
    act(() =>
      useAppStore.setState((state) => ({
        settings: {
          ...state.settings!,
          agentDefaultSurface,
          nativeChatProviders: { claude: false }
        }
      }))
    )
    await submit()
    expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
      route: 'structured-native-chat',
      requestedSurface: 'chat'
    })
    mocks.host = 'ssh:other'
    view.rerender(<NewWorkspaceComposerModal />)
    expect(screen.getByRole('combobox').textContent).toContain('Claude (CLI)')
    await submit()
    expect(mocks.submit.mock.calls.at(-1)?.[1].launchChoice).toMatchObject({
      route: 'terminal-tui',
      requestedSurface: 'terminal'
    })
  }
)

it('submits the untouched refusal-aware OpenCode CLI instead of the registered catalog chat', async () => {
  mocks.availability.mockReturnValue({
    state: 'received',
    byAgent: new Map([['opencode', { agent: 'opencode', state: 'refused' }]])
  })
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  act(() =>
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/test'),
        nativeChatProviders: EVERY_AGENT_CHAT,
        defaultTuiAgent: 'opencode'
      }
    })
  )
  expect(screen.getByRole('combobox').textContent).toContain('OpenCode (CLI)')
  await submit()
  expect(mocks.submit.mock.calls[0][1].launchChoice).toMatchObject({
    agent: 'opencode',
    route: 'terminal-tui'
  })
  expect(mocks.submit.mock.calls[0][1].launchChoice.requestedSurface).toBeUndefined()
})
