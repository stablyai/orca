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
import {
  agentPickerChoiceSeeds,
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../shared/agent-launch-picker'
import { applyAgentPickerEdit } from '../../../shared/agent-launch-picker-edits'
import * as composerDecisions from '@/hooks/composer-state/composer-decisions'
import { useFolderSubmitOrchestration } from '@/hooks/composer-state/folder-submit-orchestration'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from './sidebar/folder-workspace-composer-submit-fixtures'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  host: 'local',
  availability: vi.fn<() => HostStructuredAgentAvailability>(),
  folder: false,
  linked: false,
  accepted: vi.fn<() => { draft: AgentPickerDraft; entry: AgentPickerEntry }>(),
  create: vi.fn(async () => makeFolderWorkspace()),
  activation: vi.fn(),
  created: vi.fn(),
  error: vi.fn()
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
vi.mock('@/lib/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activateAndRevealFolderWorkspace: mocks.activation
}))
vi.mock('@/hooks/useComposerState', () => ({
  useComposerState: () => {
    const settings = useAppStore((s) => s.settings)
    const folder = useFolderSubmitOrchestration({
      clearNewWorkspaceDraft: vi.fn(),
      createFolderWorkspace: mocks.create,
      decisions: composerDecisions,
      disabledTuiAgents: [],
      folderCreateDisabled: false,
      folderSourceRepos: [],
      folderTargetIsRemote: false,
      folderTargetRuntimeEnvironmentId: null,
      isSubmissionCancelled: () => false,
      lastAutoNameRef: useRef(''),
      linkedWorkItem: mocks.linked ? linkedIssue : null,
      name: 'hi',
      note: '',
      onCreated: mocks.created,
      persistDraft: false,
      resolvePendingSmartGitHubSubmit: async () => ({ kind: 'none' }),
      selectedProjectGroup: makeProjectGroup(),
      setCreateError: mocks.error,
      setCreating: vi.fn(),
      settings,
      taskSourceContext: null,
      telemetrySource: undefined
    })
    return {
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
      submitQuick: mocks.folder ? folder.submitFolderTarget : mocks.submit,
      createDisabled: false
    }
  }
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
      <button
        onClick={() => {
          const { draft, entry } = mocks.accepted()
          p.onQuickAgentChange(draft.agent, draft.surface, draft, entry)
        }}
      >
        Accept setup
      </button>
      <button onClick={() => p.onQuickAgentChange(null)}>Blank</button>
      <button onClick={p.onQuickSetupOnlySelect}>Setup only</button>
      <button onClick={() => p.onQuickAgentChange('claude', 'terminal')}>Choose CLI</button>
      <button onClick={() => p.onQuickAgentChange('claude', 'chat')}>Choose chat</button>
    </div>
  )
}))
const linkedIssue = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 42,
  title: 'Restore folder startup',
  url: 'https://github.com/stablyai/orca/issues/42',
  repoId: 'repo-1'
}
const initial = useAppStore.getState()
beforeEach(() => {
  mocks.submit.mockReset()
  mocks.folder = false
  mocks.linked = false
  mocks.create.mockClear()
  mocks.activation.mockReset().mockReturnValue({ primaryTabId: 'tab-1' })
  mocks.created.mockClear()
  mocks.error.mockClear()
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

it.each([
  { raw: undefined, linked: false },
  { raw: '', linked: false },
  { raw: null, linked: false },
  { raw: '--verbose', linked: false },
  { raw: undefined, linked: true }
])(
  'submits the accepted complete Terminal profile through the folder adapter: $raw / linked=$linked',
  async ({ raw, linked }) => {
    mocks.folder = true
    mocks.linked = linked
    const captured = {
      ...getDefaultSettings('/test'),
      agentPermissionDefault: 'own' as const,
      agentDefaultArgs: { claude: '--verbose' },
      agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'low' } } }
    }
    const entry: AgentPickerEntry = {
      agent: 'claude',
      label: 'Claude',
      rows: [{ agent: 'claude', kind: 'terminal' }],
      surfaces: ['terminal'],
      defaultSurface: 'terminal',
      ...agentPickerChoiceSeeds('claude', captured),
      catalog: { origin: 'unknown' }
    }
    let draft = agentPickerDraft(entry)
    // Use the same domain operations as removing coupled chips in setup.
    draft = applyAgentPickerEdit(entry, draft, { kind: 'remove-chip', key: 'model' })
    draft = applyAgentPickerEdit(entry, draft, { kind: 'remove-chip', key: 'effort' })
    if (raw !== undefined) {
      draft = { ...draft, arguments: raw }
    }
    mocks.accepted.mockReturnValue({ draft, entry })
    act(() =>
      useAppStore.setState({
        settings: {
          ...captured,
          defaultTuiAgent: 'claude',
          agentDefaultSurface: 'terminal',
          agentCmdOverrides: { claude: 'cx' },
          agentDefaultArgs: { claude: '--debug' },
          agentLaunchChoices: { claude: { model: 'sonnet', options: { effort: 'high' } } },
          agentDefaultEnv: { claude: { PROFILE: 'configured' } },
          agentPermissionDefault: 'ask'
        }
      })
    )
    render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
    fireEvent.click(screen.getByText('Accept setup'))
    await submit()
    const effectiveRaw = raw === undefined ? '--verbose' : (raw ?? '')
    const baseCommand = effectiveRaw ? "cx '--verbose'" : 'cx'
    const command = linked ? `${baseCommand} --prefill '${linkedIssue.url}'` : baseCommand
    expect(mocks.create.mock.calls).toEqual([
      [
        {
          projectGroupId: 'group-1',
          name: 'hi',
          connectionId: null,
          linkedTask: linked ? linkedIssue : null,
          createdWithAgent: 'claude'
        },
        { runtimeEnvironmentId: null }
      ]
    ])
    expect(mocks.activation.mock.calls).toEqual([
      [
        'folder-workspace-1',
        {
          agent: 'claude',
          runtimeEnvironmentId: null,
          startup: {
            command,
            env: { PROFILE: 'configured' },
            launchConfig: {
              agentCommand: baseCommand,
              agentArgs: effectiveRaw,
              agentEnv: { PROFILE: 'configured' }
            },
            launchToken: expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
            launchAgent: 'claude',
            telemetry: {
              agent_kind: 'claude-code',
              launch_source: 'new_workspace_composer',
              request_kind: 'new'
            }
          }
        }
      ]
    ])
    expect(mocks.error.mock.calls).toEqual([[null]])
    expect(mocks.created).toHaveBeenCalledOnce()
  }
)
