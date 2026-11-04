// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import * as launchRoute from '@/lib/agent-launch-route-input'
import { TooltipProvider } from '@/components/ui/tooltip'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AUTOMATION_RUNTIME_CAPABILITIES } from '../../../../shared/automation-runtime-capabilities'
import { applyAutomationLaunchSetupPatch } from '../../../../shared/automation-launch-setup'
import { assertAutomationExtraAgentArgs } from '../../../../shared/automation-extra-agent-args-record'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'
import type { AutomationDraft } from './AutomationEditorDialog'
import { automationDraftLaunchSetup } from './automation-launch-surface'
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
  const view = render(<Form />)
  return { ...view, refresh: () => view.rerender(<Form />) }
}

beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  setLocalRuntimeCapabilitiesForTests(AUTOMATION_RUNTIME_CAPABILITIES)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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
    expect(accepted.launchSetupPatch.sources.arguments).toEqual({
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
    vi.spyOn(launchRoute, 'resolveHostCapabilities').mockReturnValue([])
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

  it.each(['desktop', 'legacy'] as const)(
    'keeps incompatible old extras visible after rebind on %s',
    (kind) => {
      const authority =
        kind === 'desktop'
          ? { kind: 'desktop' as const }
          : { kind: 'runtime' as const, environmentId: 'old', pairingRevision: 1 }
      vi.spyOn(launchRoute, 'resolveHostCapabilities').mockReturnValue([])
      const changed = vi.fn()
      renderSidebar(
        changed,
        { ...DRAFT, agentId: 'claude', extraAgentArgs: '--effort high' },
        authority
      )
      openPicker()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Gemini' }))
      expect(screen.getByLabelText('Extra agent arguments')).toHaveProperty(
        'value',
        '--effort high'
      )
      expect(screen.getByRole('button', { name: 'Clear arguments' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Clear arguments' }))
      expect(screen.queryByRole('button', { name: 'Clear arguments' })).toBeNull()
      const next = changed.mock.calls.reduce((draft, [update]) => update(draft), {
        ...DRAFT,
        agentId: 'claude',
        extraAgentArgs: '--effort high'
      })
      expect(next.agentId).toBe('gemini')
      expect(next.extraAgentArgs).toBe('')
    }
  )

  it('preserves a saved model while editing supplementary legacy arguments', () => {
    const changed = vi.fn()
    const initial = {
      ...DRAFT,
      agentId: 'claude' as const,
      extraAgentArgs: '--add-dir docs',
      launchPreferences: { model: 'sonnet' }
    }
    renderSidebar(changed, initial)
    fireEvent.change(screen.getByLabelText('Extra agent arguments'), {
      target: { value: '--add-dir docs --add-dir fixtures' }
    })
    const next = changed.mock.calls.at(-1)![0](initial)
    const saved = applyAutomationLaunchSetupPatch(
      { agentId: 'claude', ...automationDraftLaunchSetup(next, 'terminal', null) },
      initial
    )
    expect(saved.launchPreferences?.model).toBe('sonnet')
    expect(saved.extraAgentArgs).toBe('--add-dir docs --add-dir fixtures')
  })

  it('keeps supplementary text through the native same-agent row and Save', () => {
    const changed = vi.fn()
    const initial: AutomationDraft = {
      ...DRAFT,
      agentId: 'claude',
      extraAgentArgs: '--add-dir docs',
      launchPreferences: { model: 'sonnet' }
    }
    renderSidebar(changed, initial)
    const value = '--add-dir docs --add-dir fixtures'
    for (const partial of ['--add-dir docs ', '--add-dir "docs', '--add-dir "docs" ']) {
      fireEvent.change(screen.getByLabelText('Extra agent arguments'), {
        target: { value: partial }
      })
      expect(screen.getByLabelText('Extra agent arguments')).toHaveProperty('value', partial)
    }
    fireEvent.change(screen.getByLabelText('Extra agent arguments'), { target: { value } })
    openPicker()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }))
    expect(screen.getByLabelText('Extra agent arguments')).toHaveProperty('value', value)
    const next = changed.mock.calls.reduce((draft, [update]) => update(draft), initial)
    expect(
      applyAutomationLaunchSetupPatch(
        { agentId: 'claude', ...automationDraftLaunchSetup(next, 'terminal', null) },
        initial
      )
    ).toMatchObject({ extraAgentArgs: value, launchPreferences: { model: 'sonnet' } })
  })

  it('does not replay the rebind copy over text edited before Configure', () => {
    const changed = vi.fn()
    const initial: AutomationDraft = {
      ...DRAFT,
      agentId: 'codex',
      extraAgentArgs: '--model old'
    }
    renderSidebar(changed, initial)
    openPicker()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }))
    const value = '--add-dir docs --add-dir fixtures'
    fireEvent.change(screen.getByLabelText('Extra agent arguments'), { target: { value } })
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    fireEvent.click(screen.getByRole('option', { name: 'Model B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
    expect(screen.getByLabelText('Extra agent arguments')).toHaveProperty('value', value)
    const next = changed.mock.calls.reduce((draft, [update]) => update(draft), initial)
    expect(
      applyAutomationLaunchSetupPatch(
        { agentId: 'claude', ...automationDraftLaunchSetup(next, 'terminal', null) },
        initial
      )
    ).toMatchObject({ extraAgentArgs: value, launchPreferences: { model: 'gpt-5.5' } })
  })

  it('keeps incomplete legacy input editable across selection and validates only on Save', () => {
    const changed = vi.fn()
    const initial: AutomationDraft = {
      ...DRAFT,
      agentId: 'claude',
      extraAgentArgs: '--add-dir docs'
    }
    renderSidebar(changed, initial)
    fireEvent.change(screen.getByLabelText('Extra agent arguments'), {
      target: { value: '--add-dir "' }
    })
    openPicker()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude' }))
    expect(screen.getByLabelText('Extra agent arguments')).toHaveProperty('value', '--add-dir "')
    expect(screen.getByLabelText('Extra agent arguments').getAttribute('aria-invalid')).toBe('true')
    const invalid = changed.mock.calls.reduce((draft, [update]) => update(draft), initial)
    expect(() =>
      assertAutomationExtraAgentArgs(
        applyAutomationLaunchSetupPatch(
          {
            agentId: 'claude',
            reuseSession: invalid.reuseSession,
            ...automationDraftLaunchSetup(invalid, 'terminal', null)
          },
          initial
        )
      )
    ).toThrow()
    fireEvent.change(screen.getByLabelText('Extra agent arguments'), {
      target: { value: '--add-dir fixtures' }
    })
    const corrected = changed.mock.calls.reduce((draft, [update]) => update(draft), initial)
    expect(
      applyAutomationLaunchSetupPatch(
        { agentId: 'claude', ...automationDraftLaunchSetup(corrected, 'terminal', null) },
        initial
      ).extraAgentArgs
    ).toBe('--add-dir fixtures')
  })

  it('keeps accepted full Arguments through a legacy destination edit and return', () => {
    const capabilities = vi
      .spyOn(launchRoute, 'resolveHostCapabilities')
      .mockReturnValue(AUTOMATION_RUNTIME_CAPABILITIES)
    const changed = vi.fn()
    const initial: AutomationDraft = {
      ...DRAFT,
      agentId: 'claude',
      extraAgentArgs: '--add-dir docs',
      agentArgs: '--saved-literal --model sonnet'
    }
    const form = renderSidebar(changed, initial, {
      kind: 'runtime',
      environmentId: 'old',
      pairingRevision: 1
    })
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    const argumentsInput = [...document.querySelectorAll('textarea')].find(
      (input) => input !== screen.getByLabelText('Extra agent arguments')
    )
    expect(argumentsInput).toBeTruthy()
    fireEvent.change(argumentsInput!, {
      target: { value: '--verbose --model opus' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
    const acceptedFull = changed.mock.calls.reduce((draft, [update]) => update(draft), initial)
    expect(acceptedFull.agentArgs).toBe('--verbose --model opus')
    capabilities.mockReturnValue([])
    form.refresh()
    fireEvent.change(screen.getByLabelText('Extra agent arguments'), {
      target: { value: '--model opus --add-dir fixtures' }
    })
    capabilities.mockReturnValue(AUTOMATION_RUNTIME_CAPABILITIES)
    form.refresh()
    expect(screen.getByLabelText('Extra agent arguments')).toHaveProperty(
      'value',
      '--add-dir fixtures'
    )
    const next = changed.mock.calls.reduce((draft, [update]) => update(draft), initial)
    const saved = applyAutomationLaunchSetupPatch(
      { agentId: 'claude', ...automationDraftLaunchSetup(next, 'terminal', null) },
      initial
    )
    expect(saved.agentArgs).toContain('--verbose')
    expect(saved.agentArgs).not.toContain('--saved-literal')
    expect(saved.agentArgs).toContain('--model opus')
    expect(saved.extraAgentArgs).toBe('--add-dir fixtures')
  })

  it('retains the source reset after rebinding away and back on a legacy destination', () => {
    const capabilities = vi.spyOn(launchRoute, 'resolveHostCapabilities').mockReturnValue([])
    const changed = vi.fn()
    const initial: AutomationDraft = {
      ...DRAFT,
      agentId: 'claude',
      launchPreferences: { model: 'sonnet' },
      agentArgs: '--verbose'
    }
    const form = renderSidebar(changed, initial, {
      kind: 'runtime',
      environmentId: 'old',
      pairingRevision: 1
    })
    for (const agent of ['Codex', 'Claude']) {
      openPicker()
      fireEvent.click(screen.getByRole('menuitem', { name: agent }))
    }
    capabilities.mockReturnValue(AUTOMATION_RUNTIME_CAPABILITIES)
    form.refresh()
    const next = changed.mock.calls.reduce((draft, [update]) => update(draft), initial)
    const saved = applyAutomationLaunchSetupPatch(
      { agentId: 'claude', ...automationDraftLaunchSetup(next, 'terminal', null) },
      initial
    )
    expect(saved.launchPreferences).toBeUndefined()
    expect(saved.agentArgs).toBeUndefined()
    expect(saved.extraAgentArgs).toBe(next.extraAgentArgs)
  })

  it('sends a legacy argument edit after an earlier surface pick', () => {
    vi.spyOn(launchRoute, 'resolveHostCapabilities').mockReturnValue([])
    const changed = vi.fn()
    const initial = {
      ...DRAFT,
      surface: 'terminal' as const,
      launchSetupPatch: { surface: 'chat' as const }
    }
    renderSidebar(changed, initial, { kind: 'runtime', environmentId: 'old', pairingRevision: 1 })
    fireEvent.change(screen.getByLabelText('Extra agent arguments'), {
      target: { value: '-m gpt-5' }
    })
    const next = changed.mock.calls.at(-1)![0](initial)
    expect(
      applyAutomationLaunchSetupPatch(
        { agentId: 'codex', ...automationDraftLaunchSetup(next, 'terminal', null) },
        initial
      )
    ).toMatchObject({ surface: 'terminal', extraAgentArgs: '-m gpt-5' })
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

  it('uses desktop automation capability even when the chat route has no capabilities', () => {
    setLocalRuntimeCapabilitiesForTests([])
    renderSidebar(vi.fn())
    openPicker()
    expect(screen.getByRole('button', { name: 'Configure Codex' })).toBeTruthy()
  })

  it('uses the captured save authority even with no create-eligible destination', () => {
    renderSidebar(vi.fn(), DRAFT, { kind: 'desktop' }, destinationControl(null))
    openPicker()
    expect(screen.getByRole('button', { name: 'Configure Codex' })).toBeTruthy()
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
