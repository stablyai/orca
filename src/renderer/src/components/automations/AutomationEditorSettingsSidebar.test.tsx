// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog/agent-catalog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { AUTOMATION_RUNTIME_CAPABILITIES } from '../../../../shared/automations/automation-runtime-capabilities'

import { clearNativeChatComposerDraftsForTests } from '../native-chat/drafts/native-chat-draft-reset'
import type { AutomationAuthorityRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import type { AutomationDraft } from './AutomationEditorDialog'

import { AutomationEditorSettingsSidebar } from './AutomationEditorSettingsSidebar'

// Why: only the Agent field is under test; the sibling fields own their own coverage.
vi.mock('./AutomationProjectCombobox', () => ({ default: () => null }))
vi.mock('./AutomationWorkspaceField', () => ({ AutomationWorkspaceField: () => null }))
vi.mock('./AutomationSessionField', () => ({ AutomationSessionField: () => null }))
vi.mock('./AutomationSchedulePicker', () => ({ AutomationSchedulePicker: () => null }))
vi.mock('./AutomationMissedRunGraceField', () => ({ AutomationMissedRunGraceField: () => null }))
vi.mock('./AutomationPrecheckFields', () => ({ AutomationPrecheckFields: () => null }))
vi.mock('./AutomationSetupDecisionField', () => ({ AutomationSetupDecisionField: () => null }))
vi.mock('./AutomationDestinationField', () => ({ AutomationDestinationField: () => null }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('../tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({
    model: { state: 'loading' },
    contextKey: 'automation-test',
    detection: {
      detectedIds: [],
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => []
    }
  })
}))
vi.mock('../agent/use-agent-launch-picker-inventory', () => ({
  useAgentLaunchPickerInventory: (_id: unknown, model: { rows: { agent: string }[] }) =>
    model.rows.map((row) => ({
      agent: row.agent,
      label: row.agent,
      rows: [row],
      ownerKey: `automation-${row.agent}`,
      surfaces: ['terminal'],
      defaultSurface: 'terminal',
      terminal: { model: 'gpt-5.4', permissionMode: 'ask' },
      structured: {},
      arguments: '--base',
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          { id: 'gpt-5.4', label: 'Model A', isDefault: true, efforts: [] },
          { id: 'gpt-5.5', label: 'Model B', isDefault: false, efforts: [] }
        ]
      }
    }))
}))

const DRAFT: AutomationDraft = {
  name: '',
  prompt: '',
  agentId: 'codex',
  extraAgentArgs: '',
  projectId: '',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '30',
  preset: 'weekly',
  time: '09:15',
  dayOfWeek: '5',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  savedSchedule: null,
  scheduleWarning: null
}

function destinationControl(
  authority: AutomationAuthorityRef | null
): AutomationCreateDestinationControl {
  if (!authority) {
    return {
      entries: [],
      projects: [],
      onSelect: vi.fn(),
      resolution: { status: 'choice-required', reason: 'unselected' }
    }
  }
  const entry: AutomationHostCatalogEntry = {
    stableRef: { authority, selector: { kind: 'self' } },
    owner: { authority, selector: { kind: 'self' } },
    stableKey: 'test-host',
    label: 'Test host',
    authorityLabel: 'Test host',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped'
  }
  return {
    entries: [entry],
    projects: [],
    onSelect: vi.fn(),
    resolution: { status: 'ready', authority, destination: { selector: { kind: 'self' } }, entry }
  }
}

function renderSidebar(
  onDraftChange: (updater: (d: AutomationDraft) => AutomationDraft) => void,
  initial = DRAFT,
  authority: AutomationAuthorityRef | null = { kind: 'desktop' },
  destination = destinationControl(authority)
) {
  function Form() {
    const [draft, setDraft] = useState(initial)
    return (
      <TooltipProvider>
        <AutomationEditorSettingsSidebar
          destination={destination}
          launchAuthority={authority ?? undefined}
          surface={draft.surface ?? 'terminal'}
          chatSupported={false}
          repos={[]}
          projectHostSetups={[]}
          automationYamlHooksByRepoKey={{}}
          getAutomationHooksCacheKey={(repoId) => repoId}
          repoMap={new Map()}
          worktrees={[]}
          settings={null}
          draft={draft}
          visibleAgents={AGENT_CATALOG}
          pickerTriggerClassName=""
          onProjectChange={vi.fn()}
          onDraftChange={(updater) => {
            onDraftChange(updater)
            setDraft(updater)
          }}
          onSetupDecisionTouched={vi.fn()}
        />
      </TooltipProvider>
    )
  }
  return render(<Form />)
}

function setOldHostCapabilities(capabilities: readonly string[]) {
  act(() => {
    const status = {
      ...createCompatibleRuntimeStatusResponse().result,
      capabilities: [...capabilities]
    }
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['old', { status, checkedAt: 1 }]])
    })
  })
}

beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  setLocalRuntimeCapabilitiesForTests(AUTOMATION_RUNTIME_CAPABILITIES)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
})

function openPicker() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), { button: 0 })
}

describe('AutomationEditorSettingsSidebar agent picker', () => {
  it('keeps agent selection usable on an older host without exposing unsupported setup', () => {
    setLocalRuntimeCapabilitiesForTests([])
    const onDraftChange = vi.fn()
    setOldHostCapabilities([])
    renderSidebar(onDraftChange, DRAFT, {
      kind: 'runtime',
      environmentId: 'old',
      pairingRevision: 1
    })
    openPicker()
    expect(screen.queryByRole('button', { name: /^Configure / })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }))
    expect(onDraftChange.mock.calls[0][0](DRAFT).agentId).toBe('claude')
  })

  it('offers fresh sessions for a full launch setup and preserves its choices', () => {
    const changed = vi.fn()
    renderSidebar(changed, {
      ...DRAFT,
      reuseSession: true,
      launchPreferences: { model: 'gpt-5.5' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Use fresh sessions' }))
    const next = changed.mock.calls[0][0]({
      ...DRAFT,
      reuseSession: true,
      launchPreferences: { model: 'gpt-5.5' }
    })
    expect(next.reuseSession).toBe(false)
    expect(next.launchPreferences).toEqual({ model: 'gpt-5.5' })
  })

  it('keeps agent and legacy editing available before selecting a destination', () => {
    const changed = vi.fn()
    renderSidebar(changed, { ...DRAFT, agentId: 'claude' }, null)
    fireEvent.change(screen.getByLabelText('Extra agent arguments'), {
      target: { value: '--add-dir docs' }
    })
    openPicker()
    expect(screen.queryByRole('button', { name: /^Configure / })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
    const next = changed.mock.calls.reduce((draft, [update]) => update(draft), {
      ...DRAFT,
      agentId: 'claude'
    })
    expect(next.agentId).toBe('codex')
    expect(next.extraAgentArgs).toBe('--add-dir docs')
  })

  it('discards an unaccepted setup when the editor owner closes', () => {
    const onDraftChange = vi.fn()
    const form = renderSidebar(onDraftChange)
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '--unaccepted' } })
    form.unmount()
    renderSidebar(onDraftChange)
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
    expect(document.querySelector('textarea')).toHaveProperty('value', '--base')
    expect(onDraftChange).not.toHaveBeenCalled()
  })
})
