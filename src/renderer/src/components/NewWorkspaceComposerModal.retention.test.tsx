// @vitest-environment happy-dom
// Exercise production Modal/Card/Picker/inventory with synthetic composer targets.
import React, { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { TooltipProvider } from '@/components/ui/tooltip'
import NewWorkspaceComposerModal from './NewWorkspaceComposerModal'
import type { NewWorkspaceComposerCardProps } from './new-workspace/new-workspace-composer-card-props'
import type * as SetupButtonModule from './agent/AgentLaunchSetupButton'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentPickerDraft } from '../../../shared/agent-launch-picker'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'

const evidence = vi.hoisted(() => ({
  phase: '',
  trace: [] as {
    phase: string
    agent: string
    target?: string
    authority?: string
    initial?: AgentPickerDraft
  }[],
  submit: vi.fn()
}))
vi.mock('@/components/agent/AgentLaunchSetupButton', async (importOriginal) => {
  const original = await importOriginal<typeof SetupButtonModule>()
  return {
    ...original,
    AgentLaunchSetupButton: (
      props: React.ComponentProps<typeof SetupButtonModule.AgentLaunchSetupButton>
    ) => {
      evidence.trace.push({
        phase: evidence.phase,
        agent: props.entry.agent,
        target: props.entry.draftTarget?.key,
        authority: props.entry.ownerKey,
        initial: (props.seed ?? props.initial) && structuredClone(props.seed ?? props.initial)
      })
      return <original.AgentLaunchSetupButton {...props} />
    }
  }
})
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: async (
    _target: unknown,
    method: string,
    params: { agent: string }
  ) =>
    method === 'agentSession.modelCatalog'
      ? {
          origin: 'probe',
          fetchedAt: 1,
          models: [
            {
              id: params.agent === 'claude' ? 'opus' : 'gpt-6.1-sol',
              label: params.agent === 'claude' ? 'Opus' : 'GPT-6.1-Sol',
              isDefault: true,
              defaultEffort: 'medium',
              efforts: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Med' },
                { value: 'high', label: 'High' }
              ]
            },
            ...(params.agent === 'claude'
              ? [{ id: 'sonnet', label: 'Sonnet', efforts: [{ value: 'high', label: 'High' }] }]
              : [])
          ]
        }
      : { seedOptions: {} }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: async () => ({
    agents: [
      { agent: 'claude', capabilities: {} },
      { agent: 'codex', capabilities: {} }
    ]
  })
}))
vi.mock('@/runtime/use-host-structured-agent-availability', () => ({
  useHostStructuredAgentAvailability: () => ({
    state: 'received',
    byAgent: new Map([
      ['claude', { agent: 'claude', state: 'available' }],
      ['codex', { agent: 'codex', state: 'available' }]
    ])
  })
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'codex'],
    isLoading: false,
    isRefreshing: false,
    detectionFailed: false,
    needsServerUpdate: false,
    refresh: async () => ['claude', 'codex']
  })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('@/components/agent/AgentSettingsDialog', () => ({ default: () => null }))
vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))
vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

const noOp = () => {}
const detected = new Set<TuiAgent>(['claude', 'codex'])
const projects = [
  {
    kind: 'project' as const,
    id: 'project:w1',
    projectId: 'w1',
    displayName: 'W1 git',
    badgeColor: '',
    detail: '/w1',
    parentPath: '/w1',
    connectionId: null
  },
  {
    kind: 'project' as const,
    id: 'project:w2',
    projectId: 'w2',
    displayName: 'W2 folder',
    badgeColor: '',
    detail: '/w2',
    parentPath: '/w2',
    connectionId: null
  }
]
vi.mock('@/hooks/useComposerState', () => ({
  useComposerState: () => {
    const [project, setProject] = useState('project:w1')
    const folder = project === 'project:w2'
    const repoId = folder ? 'w2' : 'w1'
    // The same prospective target shape as resolveComposerAgentRows for local repos.
    const cardProps: Omit<
      NewWorkspaceComposerCardProps,
      'quickAgent' | 'onQuickAgentChange' | 'onOpenAgentSettings'
    > = {
      eligibleRepos: [],
      repoId,
      selectedRepoIsGit: !folder,
      projectOptions: projects,
      selectedProjectId: project,
      onProjectChange: setProject,
      onRepoChange: noOp,
      selectedRepoPath: folder ? '/w2' : '/w1',
      selectedRepoExecutionHostId: 'local',
      detectedAgentIds: detected,
      agentRows: {
        target: {
          workspace: { kind: folder ? 'folder' : 'git-worktree', repoId, executionHostId: 'local' }
        },
        detectionTarget: { kind: 'local' }
      },
      primaryActionLabel: 'Create',
      name: '',
      onNameValueChange: noOp,
      onSmartGitHubItemSelect: noOp,
      onSmartGitLabItemSelect: noOp,
      onSmartBranchSelect: noOp,
      onSmartLinearIssueSelect: noOp,
      smartNameSelection: null,
      onClearSmartNameSelection: noOp,
      canReuseSelectedBranch: false,
      reuseSelectedBranch: false,
      onReuseSelectedBranchChange: noOp,
      forkPushWarning: null,
      advancedOpen: false,
      onToggleAdvanced: noOp,
      parentWorktreeId: null,
      onParentWorktreeIdChange: noOp,
      createDisabled: false,
      projectError: null,
      creating: false,
      onCreate: noOp,
      note: '',
      onNoteChange: noOp,
      setupConfig: null,
      requiresExplicitSetupChoice: false,
      setupDecision: null,
      onSetupDecisionChange: noOp,
      setupAgentStartupPolicy: 'start-immediately',
      onSetupAgentStartupPolicyChange: noOp,
      shouldWaitForSetupCheck: false,
      resolvedSetupDecision: null,
      createError: null,
      selectedRepoConnectionId: null,
      selectedRepoSshStatus: null,
      selectedRepoRequiresConnection: false,
      selectedRepoConnectInProgress: false,
      onConnectSelectedRepo: async () => {},
      canUseSparseCheckout: false,
      sparsePresets: [],
      sparseSelectedPresetId: null,
      onSparseSelectPreset: noOp,
      branchNameOverride: undefined,
      onBranchNameOverrideChange: noOp,
      branchesEnabled: false,
      setupControlsEnabled: false,
      sparseControlsEnabled: false,
      projectHostSetupOptions: []
    }
    return {
      cardProps,
      composerRef: useRef(null),
      submitQuick: evidence.submit,
      createDisabled: false
    }
  }
}))
const initialState = useAppStore.getState()
beforeEach(() => {
  evidence.trace = []
  evidence.phase = 'mount'
  evidence.submit.mockReset()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
  useAppStore.setState({
    activeModal: 'new-workspace-composer',
    modalData: {},
    repos: [
      { ...TEST_REPO, id: 'w1', path: '/w1' },
      { ...TEST_REPO, id: 'w2', path: '/w2' }
    ],
    settings: {
      ...getDefaultSettings('/synthetic-pr35802'),
      nativeChatProviders: {},
      defaultTuiAgent: 'claude',
      agentPermissionDefault: 'own',
      agentLaunchChoices: {
        claude: { model: 'opus', options: { effort: 'medium' } },
        codex: { model: 'gpt-6.1-sol', options: { effort: 'medium' } }
      }
    },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    ensureDetectedAgents: async () => ['claude', 'codex']
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
})
const textarea = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')!
async function open(agent: string) {
  if (!document.querySelector('[role="menu"][data-state="open"]')) {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
      button: 0,
      ctrlKey: false
    })
  }
  const configure = await screen.findByRole('button', { name: `Configure ${agent}` })
  fireEvent.click(configure)
  await waitFor(() => expect(textarea()).not.toBeNull())
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: 'Low' }).hasAttribute('disabled')).toBe(false)
  )
}
async function useDraft() {
  fireEvent.blur(textarea())
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  await waitFor(() =>
    expect(
      document.querySelector(
        '[data-slot="popover-content"][aria-label^="Configure "][data-state="open"]'
      )
    ).toBeNull()
  )
}
async function closeMenu() {
  const panel = document.querySelector(
    '[data-slot="popover-content"][aria-label^="Configure "][data-state="open"]'
  )
  if (panel) {
    fireEvent.click(
      document.querySelector(`button[aria-label="${panel.getAttribute('aria-label')}"]`)!
    )
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-slot="popover-content"][aria-label^="Configure "][data-state="open"]'
        )
      ).toBeNull()
    )
  }
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Select agent"]')!
  if (trigger.getAttribute('aria-expanded') === 'true') {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  }
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
}
async function visit(label: string) {
  await closeMenu()
  fireEvent.click(screen.getByRole('button', { name: 'Browse projects' }))
  const option = await screen.findByRole('option', { name: new RegExp(label) })
  fireEvent.click(option)
  await act(async () => {})
}
function last(agent: string) {
  return evidence.trace.findLast((row) => row.agent === agent)!
}
function snapshot(phase: string) {
  const row = last('claude')
  return { phase, target: row.target, authority: row.authority, initial: row.initial }
}

it('pr35802 retains ordinary W1 accepted Low/verbose after parent echo then W2 Codex Use', async () => {
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  await open('Claude')
  const start = snapshot('w1-before')
  fireEvent.click(screen.getByRole('radio', { name: 'Low' }))
  fireEvent.change(textarea(), { target: { value: '--verbose' } })
  await useDraft()
  evidence.phase = 'w1-immediate-reopen'
  await open('Claude')
  expect(textarea().value).toBe('--verbose')
  expect(screen.getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true')
  const echo = snapshot('w1-echo')
  expect(echo.initial?.choices.options?.effort).toBe('low')
  expect(echo.initial?.arguments).toBe('--verbose')
  await visit('W2 folder')
  evidence.phase = 'w2-codex'
  await open('Codex')
  fireEvent.click(screen.getByRole('radio', { name: 'Med' }))
  await useDraft()
  await open('Codex')
  expect(screen.getByRole('radio', { name: 'Med' }).getAttribute('aria-checked')).toBe('true')
  const w2 = last('codex')
  await visit('W1 git')
  evidence.phase = 'w1-return'
  await open('Claude')
  const returned = snapshot('w1-return')
  expect(returned.target).toBe(start.target)
  expect(returned.authority).toBe(start.authority)
  expect(returned.initial).toBeUndefined()
  expect.soft(textarea().value).toBe('--verbose')
  expect.soft(screen.getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.change(textarea(), { target: { value: '--pending-after-accepted' } })
  await visit('W2 folder')
  await open('Codex')
  expect(screen.getByRole('radio', { name: 'Med' }).getAttribute('aria-checked')).toBe('true')
  expect(last('codex').authority).toBe(w2.authority)
  expect(textarea().value).toBe('')
  await visit('W1 git')
  await open('Claude')
  expect(textarea().value).toBe('--pending-after-accepted')
  expect(screen.getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true')
  expect(evidence.submit).not.toHaveBeenCalled()
})

it('pr35802 preserves the genuine same-target authority replacement reset control', async () => {
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  await open('Claude')
  const before = snapshot('before-reset')
  fireEvent.change(textarea(), { target: { value: '--verbose' } })
  await closeMenu()
  act(() =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, agentDefaultArgs: { claude: '--debug' } }
    }))
  )
  await open('Claude')
  expect(last('claude').target).toBe(before.target)
  expect(last('claude').authority).not.toBe(before.authority)
  expect(textarea().value).toBe('--debug')
  expect(evidence.submit).not.toHaveBeenCalled()
})

it('pr35802 keeps the searched W1 Sonnet High row across W2 Use as a positive control', async () => {
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  await open('Claude')
  await closeMenu()
  const openPreset = async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
      button: 0,
      ctrlKey: false
    })
    fireEvent.change(screen.getByPlaceholderText('Search agents and setups…'), {
      target: { value: 'sonnet high' }
    })
    const row = await screen.findByRole('menuitem', { name: /Claude · Sonnet · High/ })
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(textarea()).not.toBeNull())
  }
  await openPreset()
  fireEvent.change(textarea(), { target: { value: '--verbose' } })
  await useDraft()
  await visit('W2 folder')
  await open('Codex')
  await visit('W1 git')
  await openPreset()
  expect(textarea().value).toBe('--verbose')
  expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
  await visit('W2 folder')
  await open('Codex')
  fireEvent.click(screen.getByRole('radio', { name: 'Med' }))
  await useDraft()
  await visit('W1 git')
  await openPreset()
  expect(textarea().value).toBe('--verbose')
  expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
  expect(document.querySelector('[cmdk-item][data-current="true"]')?.textContent).toContain(
    'Sonnet'
  )
  fireEvent.change(textarea(), { target: { value: '--pending-preset' } })
  await visit('W2 folder')
  await open('Codex')
  await useDraft()
  await visit('W1 git')
  await openPreset()
  expect(textarea().value).toBe('--pending-preset')
  expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
  expect(evidence.submit).not.toHaveBeenCalled()
})

it('keeps accepted and newer pending ordinary intent across same-target agent switches and explicit routes', async () => {
  render(<NewWorkspaceComposerModal />, { wrapper: TooltipProvider })
  await open('Claude')
  fireEvent.click(screen.getByRole('radio', { name: 'Low' }))
  fireEvent.change(textarea(), { target: { value: '--accepted' } })
  await useDraft()
  await open('Claude')
  fireEvent.change(textarea(), { target: { value: '--pending' } })
  await closeMenu()
  for (const route of ['Chat', 'Terminal'] as const) {
    fireEvent.click(screen.getByRole('radio', { name: route }))
    await open('Claude')
    expect(textarea().value).toBe('--pending')
    expect(screen.getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true')
    await useDraft()
    expect(last('claude').initial?.surface).toBe(route.toLowerCase())
  }
  await open('Codex')
  await useDraft()
  await open('Claude')
  expect(textarea().value).toBe('--pending')
  expect(screen.getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true')
  expect(evidence.submit).not.toHaveBeenCalled()
  await useDraft()
  const captured: unknown[] = []
  for (const route of ['Chat', 'Terminal'] as const) {
    fireEvent.click(screen.getByRole('radio', { name: route }))
    await open('Claude')
    await useDraft()
    await closeMenu()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create worktree' })))
    const submitted = evidence.submit.mock.calls.at(-1)!
    expect(submitted[0]).toBe('claude')
    expect(submitted[1]).toMatchObject({
      launchChoice: {
        route: route === 'Chat' ? 'structured-native-chat' : 'terminal-tui',
        requestedSurface: route.toLowerCase()
      },
      launchInputs: { agentArgs: '--pending', sessionOptions: { effort: 'low' } }
    })
    captured.push(structuredClone(submitted))
  }
  expect(evidence.submit).toHaveBeenCalledTimes(2)
  expect(evidence.submit.mock.calls[0]).toEqual(captured[0])
})
