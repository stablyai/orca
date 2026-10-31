// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { agentLaunchPromptScopeKey } from './AgentLaunchPromptComposer'
import { changePrompt } from '../native-chat/native-chat-prompt-editor.test-support'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  writeLaunchSetupOptions
} from '../native-chat/native-chat-composer-draft-store'
import * as sources from '../native-chat/native-chat-launch-draft-source'
import { transitionLaunchDrafts } from '../native-chat/native-chat-launch-draft-transition'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
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
function folder(id: string, executionHostId: ExecutionHostId) {
  return {
    id,
    projectGroupId: 'group',
    folderPath: `/${id}`,
    name: id,
    connectionId: null,
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}
const sourceCount = () => [...sources.launchDraftSources()].length
const listFolders = (folders: ReturnType<typeof folder>[]) =>
  Object.assign(window, {
    api: { folderWorkspaces: { list: vi.fn().mockResolvedValue(folders) } }
  })

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

describe('setup records exist only for authored setups', () => {
  it.each([100, 1000])(
    'keeps %i rendered unopened rows record-free and visits only authored setups',
    async (count) => {
      const workspaces = count / AGENTS.length
      const entries = Array.from({ length: workspaces }, (_, w) =>
        AGENTS.map((agent) => row(w, agent))
      )
      const show = () =>
        act(() =>
          root.render(
            <TooltipProvider>
              <DropdownMenu defaultOpen modal={false}>
                <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
                <DropdownMenuContent>
                  {entries.map((menu, w) => (
                    <AgentLaunchPickerMenu key={w} entries={menu} runLaunch={vi.fn()} hideSearch />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </TooltipProvider>
          )
        )
      show()
      show()
      expect(document.querySelectorAll('button[aria-label^="Configure"]')).toHaveLength(count)
      expect(sourceCount()).toBe(0)
      for (const entry of entries.flat()) {
        expect(sources.launchDraftSource(agentLaunchPromptScopeKey(entry))).toBeUndefined()
      }

      // Authored control: the same k rows at N and 10N, half typed and half option changes.
      const authored = entries.slice(0, 5).map((menu) => menu[0])
      authored.forEach((entry, i) => {
        const scope = agentLaunchPromptScopeKey(entry)
        if (i % 2 === 0) {
          updateNativeChatComposerDraft(scope, { text: `task ${i}` }, 'immediate')
        } else {
          writeLaunchSetupOptions(scope, {
            agent: entry.agent,
            surface: 'chat',
            choices: { model: `model-${i}` }
          })
        }
      })
      show()
      expect(sourceCount()).toBe(authored.length)

      // Real folder catalog applies, unchanged and repeated, visit authored setups only.
      const visits: number[] = []
      const all = sources.launchDraftSources
      vi.spyOn(sources, 'launchDraftSources').mockImplementation(() => {
        const listed = [...all()]
        visits.push(listed.length)
        return listed
      })
      const local = Array.from({ length: workspaces }, (_, w) =>
        HOSTS[w % HOSTS.length] === 'local' ? [folder(`f${w}`, 'local')] : []
      ).flat()
      const store = createTestStore()
      store.setState({ folderWorkspaces: local })
      listFolders(local)
      await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
      await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
      transitionLaunchDrafts(() => undefined)
      const visitsPerApply = [...visits]
      expect(visitsPerApply).toEqual([authored.length, authored.length, authored.length])

      // A catalog pin after authoring carries the typed prompt to the row's new key.
      const pinned = [{ ...local[0], executionHostId: 'ssh:pinned' as const }, ...local.slice(1)]
      listFolders(pinned)
      await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
      const moved = {
        ...authored[0],
        rows: [{ ...authored[0].rows[0], executionHostId: 'ssh:pinned' as const }]
      }
      expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(moved)).text).toBe('task 0')
      const records = sourceCount()
      expect(records).toBe(authored.length)
      process.stdout.write(
        `${JSON.stringify({ metric: 'unopened-setup-rows', count, authored: authored.length, records, visitsPerApply })}\n`
      )
    },
    60_000
  )

  it('keeps typed prompt and options through close, reopen and a rename', () => {
    const entry = {
      ...row(0, 'codex'),
      worktreeId: 'repo::/old',
      arguments: '--add-dir docs'
    }
    const show = (value: AgentPickerEntry) =>
      act(() =>
        root.render(
          <TooltipProvider>
            <AgentLaunchSetupButton entry={value} onUse={vi.fn()} />
          </TooltipProvider>
        )
      )
    const configure = () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure codex"]')!
    const prompt = () =>
      document.querySelector<HTMLElement>('[contenteditable][aria-multiline="true"]')!
    const close = () => fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
    show(entry)
    fireEvent.click(configure())
    close()
    expect(sourceCount()).toBe(0)

    // The open panel's first write is an option change; it shows at once and retains the setup.
    fireEvent.click(configure())
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '--add-dir src' } })
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
    expect(sourceCount()).toBe(1)
    changePrompt(prompt(), 'fix the flaky test')
    close()
    expect(document.querySelector('textarea')).toBeNull()
    fireEvent.click(configure())
    expect(prompt().textContent).toBe('fix the flaky test')
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
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
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
  })
})
