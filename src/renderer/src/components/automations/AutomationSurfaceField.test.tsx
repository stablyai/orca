// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  AutomationEditorDialog,
  AUTOMATION_EDITOR_SEGMENTED_GROUP_CLASS,
  AUTOMATION_EDITOR_SEGMENTED_ITEM_CLASS,
  type AutomationDraft
} from './AutomationEditorDialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { makeStoreState } from './automations-page-fixtures'
import type { AgentLaunchRouteStore } from '@/lib/agent-launch-route-input'
import { getDefaultSettings } from '../../../../shared/constants'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AutomationSurfaceField } from './AutomationSurfaceField'
import { automationChatSupport, automationDraftSurface } from './automation-launch-surface'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { buildProfileStateCutoverFixture } from '../../../../main/persistence/profile-state-cutover-fixture'

const registryRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: registryRpc }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof routeState) => unknown) => selector(routeState)
}))
vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => undefined }))
vi.mock('./AutomationEditorPromptEditor', () => ({ getAutomationPromptEditorRoot: () => null }))
vi.mock('./AutomationEditorPromptSection', () => ({ AutomationEditorPromptSection: () => null }))
vi.mock('./AutomationEditorSettingsSidebar', () => ({
  AutomationEditorSettingsSidebar: ({
    draft,
    settings,
    chatSupported,
    onDraftChange
  }: {
    draft: AutomationDraft
    settings: GlobalSettings | null
    chatSupported: boolean | null
    onDraftChange: (updater: (draft: AutomationDraft) => AutomationDraft) => void
  }) => (
    <AutomationSurfaceField
      draft={draft}
      settings={settings}
      supported={chatSupported}
      onDraftChange={onDraftChange}
    />
  )
}))
vi.mock('./AutomationEditorDialogHeader', () => ({ AutomationEditorDialogHeader: () => null }))

import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'

function makeRouteState(): AgentLaunchRouteStore {
  return {
    ...makeStoreState().state,
    projects: [],
    projectGroups: [],
    folderWorkspaces: [],
    activeRepoId: null,
    activeWorktreeId: null,
    settings: getDefaultSettings('/tmp'),
    runtimeStatusByEnvironmentId: new Map()
  }
}

let routeState = makeRouteState()
beforeEach(() => {
  routeState = makeRouteState()
  resetHostStructuredAgentsForTests()
  registryRpc.mockReset()
})
afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this pure control reads only the default switch and selected agent/surface.
const settings = { experimentalNativeChat: true } as GlobalSettings
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unrelated editor fields are never read by this control.
const draft = { agentId: 'claude', extraAgentArgs: '--model opus' } as AutomationDraft
afterEach(cleanup)
it('places the current default on the right, highlights it, and preserves arguments through toggles', () => {
  const change = vi.fn()
  const previous = render(
    <ToggleGroup
      type="single"
      size="sm"
      spacing={1}
      value="chat"
      className={AUTOMATION_EDITOR_SEGMENTED_GROUP_CLASS}
    >
      <ToggleGroupItem value="terminal" className={AUTOMATION_EDITOR_SEGMENTED_ITEM_CLASS}>
        Terminal
      </ToggleGroupItem>
      <ToggleGroupItem value="chat" className={AUTOMATION_EDITOR_SEGMENTED_ITEM_CLASS}>
        Chat
      </ToggleGroupItem>
    </ToggleGroup>
  )
  const previousClasses = Array.from(
    previous.container.querySelectorAll<HTMLElement>(
      '[data-slot="toggle-group"], [data-slot="toggle-group-item"]'
    ),
    (element) => element.className
  )
  expect(screen.getByRole('radiogroup').hasAttribute('data-variant')).toBe(false)
  expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('data-state')).toBe('on')
  previous.unmount()
  const current = render(
    <AutomationSurfaceField draft={draft} settings={settings} supported onDraftChange={change} />
  )
  expect(
    Array.from(
      current.container.querySelectorAll<HTMLElement>(
        '[data-slot="toggle-group"], [data-slot="toggle-group-item"]'
      ),
      (element) => element.className
    )
  ).toEqual(previousClasses)
  const radios = screen.getAllByRole('radio')
  expect(radios.map((radio) => radio.textContent)).toEqual(['Terminal', 'Chat'])
  expect(radios[1].getAttribute('aria-checked')).toBe('true')
  fireEvent.click(radios[0])
  expect(change.mock.calls[0][0](draft)).toMatchObject({
    surface: 'terminal',
    extraAgentArgs: '--model opus'
  })
})
it('keeps legacy automations Terminal when the current default is Chat', () => {
  const legacy = buildAutomationEditDraft(
    buildProfileStateCutoverFixture('/fixture').automations[0]
  )
  expect(legacy.surface).toBe('terminal')
  expect(automationDraftSurface(legacy, settings, true)).toBe('terminal')
})
it('reserves disabled controls until host support is known and hides Chat on unsupported hosts', () => {
  const props = { draft, settings, onDraftChange: vi.fn() }
  const view = render(<AutomationSurfaceField {...props} supported={null} />)
  expect(screen.getAllByRole('radio').every((radio) => radio.hasAttribute('disabled'))).toBe(true)
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-checked'))).toEqual([
    'false',
    'true'
  ])
  view.rerender(<AutomationSurfaceField {...props} supported />)
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-checked'))).toEqual([
    'false',
    'true'
  ])
  expect(screen.getAllByRole('radio').some((radio) => radio.hasAttribute('disabled'))).toBe(false)
  view.rerender(<AutomationSurfaceField {...props} supported={false} />)
  expect(screen.queryByRole('radio')).toBeNull()
})
it('rederives unknown native preference for the current agent while explicit and legacy Terminal win', () => {
  const perAgent = { ...settings, nativeChatProviders: { claude: false } }
  expect(automationDraftSurface(draft, perAgent, null)).toBe('terminal')
  expect(automationDraftSurface({ ...draft, agentId: 'codex' }, perAgent, null)).toBe('chat')
  const change = vi.fn()
  const view = render(
    <AutomationSurfaceField
      draft={draft}
      settings={perAgent}
      supported={null}
      onDraftChange={change}
    />
  )
  expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
    'Chat',
    'Terminal'
  ])
  expect(screen.getAllByRole('radio')[1].getAttribute('aria-checked')).toBe('true')
  view.rerender(
    <AutomationSurfaceField
      draft={{ ...draft, agentId: 'codex' }}
      settings={perAgent}
      supported={null}
      onDraftChange={change}
    />
  )
  expect(screen.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
    'Terminal',
    'Chat'
  ])
  expect(screen.getAllByRole('radio')[1].getAttribute('aria-checked')).toBe('true')
  for (const supported of [null, true, false]) {
    expect(automationDraftSurface({ ...draft, surface: 'terminal' }, settings, supported)).toBe(
      'terminal'
    )
  }
  expect(automationDraftSurface({ ...draft, surface: 'chat' }, settings, false)).toBe('chat')
})

it('the real field and footer withhold native Chat until current registration publishes', async () => {
  const fixtures = makeStoreState()
  const { surface: _legacy, ...newDraft } = buildAutomationEditDraft(
    buildProfileStateCutoverFixture('/fixture').automations[0]
  )
  const onSave = vi.fn()
  const props = {
    open: true,
    isEditing: false,
    isSaving: false,
    canSave: true,
    repos: fixtures.state.repos,
    projectHostSetups: fixtures.state.projectHostSetups,
    automationYamlHooksByRepoKey: {},
    getAutomationHooksCacheKey: (id: string) => id,
    repoMap: fixtures.repoMap,
    worktrees: [...fixtures.worktreeMap.values()],
    settings,
    draft: { ...newDraft, agentId: 'pi' as const },
    onProjectChange: vi.fn(),
    onOpenChange: vi.fn(),
    onDraftChange: vi.fn(),
    onSetupDecisionTouched: vi.fn(),
    onApplyTemplate: vi.fn(),
    onSave
  }
  setLocalRuntimeCapabilitiesForTests(registeredCapabilities)
  const view = render(<AutomationEditorDialog {...props} />)
  const button = screen.getByRole('button', { name: 'Create' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-checked'))).toEqual([
    'false',
    'true'
  ])
  expect(screen.getAllByRole('radio').every((radio) => radio.hasAttribute('disabled'))).toBe(true)
  registryRpc.mockResolvedValue({ agents: [{ agent: 'pi', capabilities: {} }] })
  await loadHostStructuredAgents('local', registeredCapabilities, null)
  view.rerender(<AutomationEditorDialog {...props} />)
  expect(button.hasAttribute('disabled')).toBe(false)
  fireEvent.click(button)
  expect(onSave).toHaveBeenCalledOnce()
  setLocalRuntimeCapabilitiesForTests(null)
  view.rerender(
    <AutomationEditorDialog {...props} draft={{ ...props.draft, surface: 'terminal' }} />
  )
  expect(button.hasAttribute('disabled')).toBe(false)
  view.rerender(<AutomationEditorDialog {...props} draft={{ ...props.draft, surface: 'chat' }} />)
  expect(button.hasAttribute('disabled')).toBe(true)
  setLocalRuntimeCapabilitiesForTests([])
  view.rerender(<AutomationEditorDialog {...props} draft={{ ...props.draft, surface: 'chat' }} />)
  expect(button.hasAttribute('disabled')).toBe(true)
})

const registeredCapabilities = [
  AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]

it('observes only established current-runtime facts and retains independent definitive blockers', async () => {
  const pi = { ...draft, agentId: 'pi' as const }
  const local = { kind: 'git-worktree' as const }
  const support = () => automationChatSupport(routeState, pi, local)
  setLocalRuntimeCapabilitiesForTests(registeredCapabilities)
  expect(support()).toBeNull()
  expect(automationChatSupport(routeState, draft, local)).toBe(true)
  for (const response of [new Error('offline'), {}]) {
    registryRpc.mockImplementation(async () => {
      if (response instanceof Error) {
        throw response
      }
      return response
    })
    await loadHostStructuredAgents('local', registeredCapabilities, null)
    expect(support()).toBeNull()
  }
  registryRpc.mockResolvedValue({ agents: [] })
  await loadHostStructuredAgents('local', registeredCapabilities, null)
  expect(support()).toBe(false)
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(
    registeredCapabilities.filter(
      (c) => c !== STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
    )
  )
  expect(support()).toBe(false)
  setLocalRuntimeCapabilitiesForTests(
    registeredCapabilities.filter((c) => c !== STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
  )
  expect(support()).toBe(false)
  setLocalRuntimeCapabilitiesForTests(null)
  expect(support()).toBeNull()
  expect(automationChatSupport(routeState, pi, { ...local, executionHostId: 'ssh:remote' })).toBe(
    false
  )
  const paired = { ...local, executionHostId: 'runtime:paired' }
  const pairedStatus: RuntimeStatus = {
    runtimeId: 'A',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    capabilities: registeredCapabilities
  }
  routeState.runtimeStatusByEnvironmentId = new Map([
    ['paired', { checkedAt: 0, status: pairedStatus }]
  ])
  registryRpc.mockResolvedValue({ agents: [{ agent: 'pi', capabilities: {} }] })
  await loadHostStructuredAgents('runtime:paired', registeredCapabilities, 'A')
  expect(automationChatSupport(routeState, pi, paired)).toBe(true)
  routeState.runtimeStatusByEnvironmentId = new Map([
    ['paired', { checkedAt: 0, status: { ...pairedStatus, runtimeId: 'B' } }]
  ])
  expect(automationChatSupport(routeState, pi, paired)).toBeNull()
  routeState.runtimeStatusByEnvironmentId = new Map([
    [
      'paired',
      {
        checkedAt: 0,
        status: {
          ...pairedStatus,
          runtimeId: 'B',
          capabilities: registeredCapabilities.filter(
            (c) => c !== STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
          )
        }
      }
    ]
  ])
  expect(automationChatSupport(routeState, pi, paired)).toBe(false)
})
