// @vitest-environment happy-dom
import { act, type ReactElement, type ReactNode } from 'react'
import { fireEvent, getByRole } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { retireAgentPickerDrafts } from './agent-launch-picker-drafts'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { agentLaunchPromptScopeKey } from './AgentLaunchPromptComposer'
import { changePrompt } from '../native-chat/composer/editor/native-chat-prompt-editor.test-support'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/drafts/native-chat-draft-reset'
import { readNativeChatComposerDraft } from '../native-chat/drafts/native-chat-composer-draft-store'
import { writeLaunchSetupOptions } from '../native-chat/drafts/native-chat-composer-draft-memory'
import * as sources from '../native-chat/drafts/native-chat-launch-draft-source'
import { transitionLaunchDrafts } from '../native-chat/drafts/native-chat-launch-draft-transition'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { ExecutionHostId } from '../../../../shared/execution-host'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))

const AGENTS = ['claude', 'codex'] as const
const HOSTS: ExecutionHostId[] = ['local', 'ssh:h1', 'runtime:r1']
function row(workspace: number, agent: (typeof AGENTS)[number]): AgentPickerEntry {
  return {
    agent,
    label: agent,
    rows: [{ agent, kind: 'terminal', executionHostId: HOSTS[workspace % HOSTS.length] }],
    surfaces: ['chat', 'terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'unknown' },
    ownerKey: `owner-${workspace}`,
    worktreeId: `folder:f${workspace}`
  }
}
const sourceCount = () => [...sources.launchDraftSources()].length
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'api')
  clearNativeChatComposerDraftsForTests()
})

const anchor = (trigger: ReactElement) => <div>{trigger}</div>

function InMenu({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent>{children}</DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

describe('setup records exist only for authored setups', () => {
  it('keeps typed prompt and options through close, reopen and a rename', () => {
    const entry: AgentPickerEntry = {
      ...row(0, 'codex'),
      worktreeId: 'repo::/old',
      arguments: '--add-dir docs',
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          {
            id: 'gpt',
            label: 'gpt',
            isDefault: true,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ]
          }
        ]
      }
    }
    const show = (value: AgentPickerEntry) =>
      act(() =>
        root.render(
          <InMenu>
            <AgentLaunchSetupButton entry={value} onUse={vi.fn()} renderAnchor={anchor} />
          </InMenu>
        )
      )
    const configure = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure codex"]')!
    const prompt = () =>
      document.querySelector<HTMLElement>('[contenteditable][aria-multiline="true"]')!
    const effort = (label: string) =>
      getByRole(document.body, 'radio', { name: label }).getAttribute('data-state')
    const close = () =>
      fireEvent.keyDown(document.querySelector('[cmdk-input]')!, { key: 'Escape' })
    show(entry)
    fireEvent.click(configure())
    close()
    expect(sourceCount()).toBe(0)

    // The open panel's first write is an option change; it shows at once and retains the setup.
    fireEvent.click(configure())
    // Arguments are agent settings, so the launch panel offers no editor for them.
    expect(document.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
    fireEvent.click(getByRole(document.body, 'radio', { name: 'Low' }))
    expect(effort('Low')).toBe('on')
    expect(sourceCount()).toBe(1)
    changePrompt(prompt(), 'fix the flaky test')
    close()
    expect(document.querySelector('[cmdk-input]')).toBeNull()
    fireEvent.click(configure())
    expect(prompt().textContent).toBe('fix the flaky test')
    expect(effort('Low')).toBe('on')
    close()

    act(() =>
      transitionLaunchDrafts((source) =>
        source.workspaceId === 'repo::/old'
          ? { workspaceId: 'repo::/new', executionHostId: source.executionHostId }
          : undefined
      )
    )
    show({ ...entry, worktreeId: 'repo::/new' })
    fireEvent.click(configure())
    expect(prompt().textContent).toBe('fix the flaky test')
    expect(effort('Low')).toBe('on')
  })

  it('keeps a search preset in its own options slot, saving only real changes, with one shared prompt', async () => {
    const entry: AgentPickerEntry = {
      ...row(0, 'claude'),
      worktreeId: 'repo::/w',
      arguments: '--add-dir docs',
      catalog: {
        origin: 'probe',
        fetchedAt: 1,
        models: ['opus', 'sonnet'].map((id) => ({
          id,
          label: id,
          isDefault: false,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }))
      }
    }
    const preset = {
      agent: 'claude' as const,
      surface: 'terminal' as const,
      choices: { model: 'opus', options: { effort: 'high' } }
    }
    act(() =>
      root.render(
        <InMenu>
          <AgentLaunchSetupButton entry={entry} onUse={vi.fn()} renderAnchor={anchor} />
          <AgentLaunchSetupButton
            entry={entry}
            initial={preset}
            onUse={vi.fn()}
            renderAnchor={anchor}
          />
        </InMenu>
      )
    )
    const user = userEvent.setup()
    const [plain, searched] = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Configure claude"]'
    )
    const prompt = () =>
      document.querySelector<HTMLElement>('[contenteditable][aria-multiline="true"]')!
    const effort = (label: string) =>
      getByRole(document.body, 'radio', { name: label }).getAttribute('data-state')
    const model = () => document.querySelector('[cmdk-item][data-current="true"]')?.textContent
    const close = () =>
      fireEvent.keyDown(document.querySelector('[cmdk-input]')!, { key: 'Escape' })

    // Opening a preset saves nothing, and the plain row still shows defaults.
    fireEvent.click(searched)
    expect(model()).toBe('opus')
    expect(effort('High')).toBe('on')
    close()
    expect(sourceCount()).toBe(0)
    fireEvent.click(plain)
    // Defaults: nothing chosen, so the agent keeps its own model.
    expect(model()).toBeUndefined()
    close()
    expect(sourceCount()).toBe(0)

    // A real change saves into that preset's slot only and survives close and reopen.
    fireEvent.click(searched)
    await user.click(getByRole(document.body, 'radio', { name: 'Low' }))
    expect(effort('Low')).toBe('on')
    expect(sourceCount()).toBe(1)
    changePrompt(prompt(), 'review the diff')
    close()
    fireEvent.click(searched)
    expect(model()).toBe('opus')
    expect(effort('Low')).toBe('on')
    close()

    // The plain row keeps its own options but shares the workspace's typed prompt.
    fireEvent.click(plain)
    expect(model()).toBeUndefined()
    expect(prompt().textContent).toBe('review the diff')
    close()
    expect(sourceCount()).toBe(1)
    const scope = agentLaunchPromptScopeKey(entry)
    writeLaunchSetupOptions(scope, {
      agent: 'claude',
      surface: 'terminal',
      choices: {},
      pendingArguments: '--ordinary'
    })
    retireAgentPickerDrafts([{ ...entry, catalog: { origin: 'probe', fetchedAt: 2, models: [] } }])
    expect(sources.readLaunchSetupOptions(scope, JSON.stringify(preset.choices))).toBeUndefined()
    expect(sources.readLaunchSetupOptions(scope)?.pendingArguments).toBe('--ordinary')
    expect(readNativeChatComposerDraft(scope).text).toBe('review the diff')
  })
})
