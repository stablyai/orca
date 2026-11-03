// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AUTOMATION_RUNTIME_CAPABILITIES } from '../../../../shared/automation-runtime-capabilities'
import { applyAutomationLaunchSetupPatch } from '../../../../shared/automation-launch-setup'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'
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
vi.mock('./AutomationExtraAgentArgsField', () => ({ AutomationExtraAgentArgsField: () => null }))
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
      terminal: { model: 'gpt-5.4' },
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

function renderSidebar(onDraftChange: (updater: (d: AutomationDraft) => AutomationDraft) => void) {
  function Form() {
    const [draft, setDraft] = useState(DRAFT)
    return (
      <TooltipProvider>
        <AutomationEditorSettingsSidebar
          surface="terminal"
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
          segmentedGroupClassName=""
          segmentedItemClassName=""
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

beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  setLocalRuntimeCapabilitiesForTests(AUTOMATION_RUNTIME_CAPABILITIES)
})
afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
})

function openPicker() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), { button: 0 })
}

describe('AutomationEditorSettingsSidebar agent picker', () => {
  it('offers agents only, never Blank Terminal', () => {
    const onDraftChange = vi.fn()
    renderSidebar(onDraftChange)

    openPicker()

    expect(screen.queryByRole('menuitem', { name: 'Blank Terminal' })).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Configure / })).toHaveLength(
      AGENT_CATALOG.length
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }))
    expect(onDraftChange).toHaveBeenCalledTimes(1)
    const updater = onDraftChange.mock.calls[0][0]
    expect(updater(DRAFT).agentId).toBe('claude')
  })

  it('keeps observation read-only and accepts full Arguments only when the shared panel is used', () => {
    const onDraftChange = vi.fn()
    renderSidebar(onDraftChange)
    const trigger = screen.getByRole('button', { name: 'Select agent' })
    const caption = trigger.textContent
    openPicker()
    expect(trigger.textContent).toBe(caption)
    expect(onDraftChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
    fireEvent.change(document.querySelector('textarea')!, {
      target: { value: '--search --add-dir docs' }
    })
    expect(onDraftChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
    expect(onDraftChange).toHaveBeenCalledTimes(1)
    const accepted = onDraftChange.mock.calls[0][0](DRAFT)
    expect(accepted.agentArgs).toBe('--search --add-dir docs')
    expect(accepted.launchSetupPatch.arguments).toEqual({
      kind: 'value',
      value: '--search --add-dir docs'
    })
    expect(accepted.launchPreferences?.model).toBeUndefined()
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
    expect(document.querySelector('textarea')).toHaveProperty('value', '--search --add-dir docs')
  })

  it('keeps agent selection usable on an older host without exposing unsupported setup', () => {
    setLocalRuntimeCapabilitiesForTests([])
    const onDraftChange = vi.fn()
    renderSidebar(onDraftChange)
    openPicker()
    expect(screen.queryByRole('button', { name: /^Configure / })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }))
    expect(onDraftChange.mock.calls[0][0](DRAFT).agentId).toBe('claude')
  })

  it('retains explicit equal choices and folds accepted raw/control edits in their authored order', () => {
    const onDraftChange = vi.fn()
    const current = () => onDraftChange.mock.calls.reduce((draft, [update]) => update(draft), DRAFT)
    renderSidebar(onDraftChange)
    const openSetup = () => {
      openPicker()
      fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
    }
    const use = () => fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
    openSetup()
    fireEvent.click(screen.getByRole('option', { name: 'Model A' }))
    use()
    expect(onDraftChange.mock.calls.at(-1)?.[0](DRAFT).launchPreferences.model).toBe('gpt-5.4')
    openSetup()
    fireEvent.change(document.querySelector('textarea')!, {
      target: { value: '--model gpt-5.5 --search' }
    })
    use()
    const raw = current()
    expect(raw.agentArgs).toBe('--model gpt-5.5 --search')
    expect(raw.launchPreferences?.model).toBeUndefined()
    openSetup()
    fireEvent.click(screen.getByRole('option', { name: 'Model A' }))
    use()
    const final = current()
    const saved = applyAutomationLaunchSetupPatch({
      agentId: 'codex',
      launchSetupPatch: final.launchSetupPatch
    })
    expect(saved.launchPreferences?.model).toBe('gpt-5.4')
    expect(saved.agentArgs).toBe('--search')
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
