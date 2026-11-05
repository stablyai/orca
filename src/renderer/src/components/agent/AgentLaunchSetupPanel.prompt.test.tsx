// @vitest-environment happy-dom
import { compilePickerTerminalLaunch } from './agent-launch-picker-menu-test-fixture'
import {
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { entry, root } from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent, getByRole, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { agentLaunchPromptScopeKey } from './AgentLaunchPromptComposer'
import { changePrompt } from '../native-chat/native-chat-prompt-editor.test-support'
import { readNativeChatComposerDraft } from '../native-chat/native-chat-composer-draft-store'
import { EntryActionRow } from '../tab-bar/TabBarCreateEntryRow'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

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
            isDefault: true
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
    fireEvent.change(panel().querySelector('textarea')!, {
      target: { value: '--add-dir "authored exact path"' }
    })
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
        </TooltipProvider>
      )
    )
    fireEvent.click(configure())
    expect(panel().querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      '--add-dir "authored exact path"'
    )
    expect(panel().querySelector('[contenteditable]')?.textContent).toContain('exact-file.ts')
    launch.mockReturnValueOnce(false)
    fireEvent.keyDown(panel().querySelector('textarea')!, { key: 'Enter' })
    await waitFor(() => expect(launch).toHaveBeenCalledOnce())
    const inputs = agentPickerLaunchInputs(launch.mock.lastCall![1], refreshed)
    expect(inputs).toMatchObject({
      agentArgs: '--add-dir "authored exact path"',
      sessionOptions: { model: 'selected', effort: 'high' }
    })
    expect(compilePickerTerminalLaunch(launch.mock.lastCall![1], refreshed)).toMatchObject({
      ok: true,
      tokens:
        agent === 'claude'
          ? [
              'claude',
              '--add-dir',
              'authored exact path',
              '--model',
              'selected',
              '--effort',
              'high'
            ]
          : [
              'codex',
              '-c',
              'disable_paste_burst=true',
              '--add-dir',
              'authored exact path',
              '-m',
              'selected',
              '-c',
              'model_reasoning_effort=high'
            ]
    })
    await waitFor(() =>
      expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(refreshed)).text).toBe(
        source.text
      )
    )
    fireEvent.click(getByRole(document.body, 'button', { name: 'Launch terminal' }))
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(2))
    expect(launch.mock.lastCall![1]).toMatchObject({
      prompt: 'keep @/repo/exact-file.ts',
      argumentsOwner: refreshed.ownerKey
    })
    await waitFor(() =>
      expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(refreshed)).text).toBe('')
    )
  }
)
