// @vitest-environment happy-dom
import { compilePickerTerminalLaunch } from './agent-launch-picker-menu-test-fixture'
import {
  agentPickerLaunchInputs,
  agentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { entry, root } from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent, getByRole, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { agentLaunchPromptScopeKey } from './AgentLaunchPromptComposer'
import { changePrompt } from '../native-chat/composer/editor/native-chat-prompt-editor.test-support'
import { readNativeChatComposerDraft } from '../native-chat/drafts/native-chat-composer-draft-store'
import { EntryActionRow } from '../tab-bar/TabBarCreateEntryRow'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { groupAntigravityModelEfforts } from '../../../../shared/agent-session/options/antigravity-model-efforts'

it('launches an untouched saved literal Antigravity pair through the actual setup footer', async () => {
  const saved = { model: 'gemini-3.8-flash-high', options: { effort: 'low' } }
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'antigravity',
    label: 'Antigravity',
    worktreeId: 'repo::/untouched-saved-pair',
    rows: [{ agent: 'antigravity', kind: 'cli', executionHostId: 'local' }],
    surfaces: ['terminal'],
    arguments: '',
    terminal: saved,
    terminalCatalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: groupAntigravityModelEfforts([
        { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
        { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }
      ])
    }
  }
  const launch = vi.fn().mockReturnValue(true)
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu entries={[own]} runLaunch={launch} />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
  fireEvent.click(getByRole(document.body, 'button', { name: 'Configure Antigravity' }))
  fireEvent.click(getByRole(document.body, 'button', { name: 'Launch terminal' }))
  await waitFor(() => expect(launch).toHaveBeenCalledOnce())
  expect(
    compilePickerTerminalLaunch(launch.mock.lastCall![1], own, {
      agentDefaultArgs: { antigravity: '' },
      agentLaunchChoices: { antigravity: saved }
    })
  ).toMatchObject({
    ok: true,
    tokens: ['antigravity', '--model', 'gemini-3.8-flash-low']
  })
})

it.each(['dedicated', 'arguments'] as const)(
  'clears %s Low through Configure Default while preserving permission and raw flags',
  async (source) => {
    const saved = { model: 'gemini-3.8-flash', options: { effort: 'low' } }
    const own: AgentPickerEntry = {
      ...entry,
      agent: 'antigravity',
      label: 'Antigravity',
      worktreeId: 'repo::/clear-effort',
      rows: [{ agent: 'antigravity', kind: 'cli' }],
      surfaces: ['terminal'],
      arguments: source === 'arguments' ? '--effort low --add-dir docs' : '--add-dir docs',
      terminal: { ...saved, permissionMode: 'full-access' },
      terminalCatalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: groupAntigravityModelEfforts([
          { id: 'gemini-3.8-flash-low', label: 'Flash (Low)' },
          { id: 'gemini-3.8-flash-high', label: 'Flash (High)' }
        ])
      }
    }
    const settings = {
      agentPermissionDefault: 'full-access' as const,
      agentDefaultArgs: { antigravity: own.arguments ?? '' },
      agentLaunchChoices: { antigravity: saved }
    }
    const ordinary = compilePickerTerminalLaunch(agentPickerDraft(own), own, settings)
    expect(ordinary).toMatchObject({
      ok: true,
      tokens: [
        'antigravity',
        '--model',
        'gemini-3.8-flash',
        '--dangerously-skip-permissions',
        '--add-dir',
        'docs'
      ]
    })
    const launch = vi.fn().mockReturnValue(true)
    act(() =>
      root.render(
        <TooltipProvider>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
            <DropdownMenuContent>
              <AgentLaunchPickerMenu entries={[own]} runLaunch={launch} />
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      )
    )
    fireEvent.click(getByRole(document.body, 'button', { name: 'Configure Antigravity' }))
    // Re-clicking the current level preserves it; Default must instead clear it.
    fireEvent.click(getByRole(document.body, 'radio', { name: 'Low' }))
    fireEvent.click(getByRole(document.body, 'radio', { name: 'Default' }))
    fireEvent.click(getByRole(document.body, 'button', { name: 'Launch terminal' }))
    await waitFor(() => expect(launch).toHaveBeenCalledOnce())
    expect(agentPickerLaunchInputs(launch.mock.lastCall![1], own)).toMatchObject({
      terminalOptionEdits: { effort: null }
    })
    expect(compilePickerTerminalLaunch(launch.mock.lastCall![1], own, settings)).toMatchObject({
      ok: true,
      tokens: [
        'antigravity',
        '--model',
        'gemini-3.8-flash',
        '--dangerously-skip-permissions',
        '--add-dir',
        'docs'
      ]
    })
  }
)

it.each(['button', 'enter'] as const)(
  'keeps a terminal search edit through catalog refresh and launches via %s with a Chat default',
  async (action) => {
    const own: AgentPickerEntry = {
      ...entry,
      agent: 'antigravity',
      label: 'Antigravity',
      worktreeId: `repo::/terminal-search-${action}`,
      rows: [
        { agent: 'antigravity', kind: 'chat' },
        { agent: 'antigravity', kind: 'cli' }
      ],
      defaultSurface: 'chat',
      arguments: '',
      terminal: {},
      structured: { model: 'chat-only' },
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [{ id: 'chat-only', label: 'Chat only', isDefault: false, efforts: [] }]
      },
      terminalCatalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: groupAntigravityModelEfforts([
          { id: 'gemini-3.8-flash-low', label: 'Flash (Low)' },
          { id: 'gemini-3.8-flash-high', label: 'Flash (High)' }
        ])
      }
    }
    const launch = vi.fn().mockReturnValue(false)
    const show = (value: AgentPickerEntry) =>
      act(() =>
        root.render(
          <TooltipProvider>
            <DropdownMenu defaultOpen modal={false}>
              <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
              <DropdownMenuContent>
                <AgentLaunchPickerMenu entries={[value]} runLaunch={launch} />
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        )
      )
    show(own)
    const search = getByRole(document.body, 'textbox')
    fireEvent.change(search, { target: { value: 'AGY Flash High' } })
    fireEvent.click(getByRole(document.body, 'button', { name: 'Configure Antigravity' }))
    fireEvent.click(getByRole(document.body, 'radio', { name: 'Low' }))
    if (!own.terminalCatalog || own.terminalCatalog.origin === 'unknown') {
      throw new Error('Expected terminal catalog')
    }
    const refreshed: AgentPickerEntry = {
      ...own,
      terminalCatalog: { ...own.terminalCatalog, fetchedAt: 2 }
    }
    show(refreshed)
    if (action === 'button') {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Launch terminal' }))
    } else {
      const panel = document.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu-sub-content"], [data-slot="popover-content"]'
      )!
      fireEvent.keyDown(panel.querySelector('input')!, { key: 'Enter' })
    }
    await waitFor(() => expect(launch).toHaveBeenCalledOnce())
    expect(launch.mock.lastCall![0]).toMatchObject({ agent: 'antigravity', kind: 'cli' })
    expect(compilePickerTerminalLaunch(launch.mock.lastCall![1], refreshed)).toMatchObject({
      ok: true,
      tokens: ['antigravity', '--model', 'gemini-3.8-flash-low', '--dangerously-skip-permissions']
    })
    fireEvent.keyDown(
      document.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu-sub-content"], [data-slot="popover-content"]'
      )!,
      { key: 'Escape' }
    )
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(getByRole(document.body, 'button', { name: 'Antigravity' }))
    expect(launch.mock.lastCall).toEqual([{ agent: 'antigravity', kind: 'chat' }, undefined])
    expect(own.structured).toEqual({ model: 'chat-only' })
  }
)

it.each(['claude', 'codex'] as const)(
  'both actual setup callers retain rich %s input/options across freshness, refusal and explicit retry',
  async (agent) => {
    const own: AgentPickerEntry = {
      ...entry,
      agent,
      label: agent,
      worktreeId: 'repo::/setup',
      rows: [{ agent, kind: 'cli', executionHostId: 'local' }],
      defaultSurface: 'terminal',
      ownerKey: 'initial-defaults',
      arguments: '--add-dir inherited',
      terminal: {},
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          {
            id: 'selected',
            label: 'Selected',
            efforts: [{ value: 'high', label: 'High' }],
            isDefault: true,
            supportsFastMode: true,
            serviceTiers: [{ value: 'fast', label: 'Fast' }]
          }
        ]
      }
    }
    const launch = vi.fn().mockReturnValue(true)
    act(() =>
      root.render(
        <TooltipProvider>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
            <DropdownMenuContent>
              <AgentLaunchPickerMenu entries={[own]} runLaunch={launch} />
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      )
    )
    const configure = () =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="Configure ${agent}"]`)!
    fireEvent.click(configure())
    const panel = () =>
      document.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu-sub-content"], [data-slot="popover-content"]'
      )!
    fireEvent.click(panel().querySelector('[cmdk-item]')!)
    fireEvent.click(getByRole(document.body, 'radio', { name: 'High' }))
    // A speed edit copies the current Arguments into the draft; later settings must still win.
    fireEvent.click(getByRole(document.body, 'button', { name: 'Fast' }))
    changePrompt(
      panel().querySelector<HTMLElement>('[contenteditable]')!,
      'keep @/repo/exact-file.ts'
    )
    const source = readNativeChatComposerDraft(agentLaunchPromptScopeKey(own))
    fireEvent.keyDown(panel(), { key: 'Escape' })
    const refreshed = {
      ...own,
      ownerKey: 'refreshed-runtime-and-defaults',
      defaultsPending: true,
      arguments: '--add-dir new-default'
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
            <DropdownMenuContent>
              <EntryActionRow
                id="actual-search-row"
                option={{
                  kind: 'agent',
                  option: { agent, aliases: [], label: agent, pickerEntry: refreshed }
                }}
                selected={false}
                onClick={() => launch(undefined)}
                onUseAgent={(draft) => launch(own.rows[0], draft, refreshed)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      )
    )
    fireEvent.click(configure())
    expect(panel().querySelector('textarea[aria-label="Arguments"]')).toBeNull()
    expect(panel().querySelector('[contenteditable]')?.textContent).toContain('exact-file.ts')
    launch.mockReturnValueOnce(false)
    fireEvent.click(getByRole(document.body, 'button', { name: 'Launch terminal' }))
    await waitFor(() => expect(launch).toHaveBeenCalledOnce())
    const inputs = agentPickerLaunchInputs(launch.mock.lastCall![1], refreshed)
    expect(inputs).toMatchObject({ sessionOptions: { model: 'selected', effort: 'high' } })
    expect(compilePickerTerminalLaunch(launch.mock.lastCall![1], refreshed)).toMatchObject({
      ok: true,
      tokens:
        agent === 'claude'
          ? [
              'claude',
              '--dangerously-skip-permissions',
              '--model',
              'selected',
              '--effort',
              'high',
              '--settings',
              '{"fastMode":true}'
            ]
          : [
              'codex',
              '-c',
              'disable_paste_burst=true',
              '--dangerously-bypass-approvals-and-sandbox',
              '-m',
              'selected',
              '-c',
              'model_reasoning_effort=high',
              '-c',
              'service_tier=fast'
            ]
    })
    await waitFor(() =>
      expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(refreshed)).text).toBe(
        source.text
      )
    )
    fireEvent.click(getByRole(document.body, 'button', { name: 'Launch terminal' }))
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(2))
    expect(launch.mock.lastCall![1]).toMatchObject({ prompt: 'keep @/repo/exact-file.ts' })
    await waitFor(() =>
      expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(refreshed)).text).toBe('')
    )
  }
)

it('removes a model-less saved Low chip and uses current destination Arguments and permission', async () => {
  const own: AgentPickerEntry = {
    ...entry,
    agent: 'antigravity',
    label: 'Antigravity',
    worktreeId: 'repo::/model-less-default',
    rows: [{ agent: 'antigravity', kind: 'cli' }],
    surfaces: ['terminal'],
    terminal: { options: { effort: 'low' }, permissionMode: 'ask' },
    arguments: '--add-dir old',
    terminalCatalog: { origin: 'probe', fetchedAt: 1, models: [] }
  }
  const launch = vi.fn().mockReturnValue(true)
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu entries={[own]} runLaunch={launch} />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
  fireEvent.click(getByRole(document.body, 'button', { name: 'Configure Antigravity' }))
  fireEvent.click(getByRole(document.body, 'button', { name: 'Remove --effort low' }))
  fireEvent.click(getByRole(document.body, 'button', { name: 'Launch terminal' }))
  await waitFor(() => expect(launch).toHaveBeenCalledOnce())
  const inputs = agentPickerLaunchInputs(launch.mock.lastCall![1], own)
  expect(inputs).toEqual({ terminalOptionEdits: { effort: null } })
  expect(
    compilePickerTerminalLaunch(launch.mock.lastCall![1], own, {
      agentPermissionDefault: 'full-access',
      agentDefaultArgs: { antigravity: '--effort=medium --add-dir new' },
      agentLaunchChoices: { antigravity: { options: { effort: 'high' } } }
    })
  ).toMatchObject({
    ok: true,
    tokens: ['antigravity', '--dangerously-skip-permissions', '--add-dir', 'new']
  })
})
