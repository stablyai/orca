// @vitest-environment happy-dom
import {
  mockCreateTab,
  mockCreateSupport,
  mockLaunchStructuredCodexSession
} from './launch-agent-structured-chat-test-fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentLaunchPickerMenu } from '@/components/agent/AgentLaunchPickerMenu'
import { useTabAgentMenuLaunch } from '@/components/tab-bar/QuickLaunchButton'
import TabBarCreateEntry from '@/components/tab-bar/TabBarCreateEntry'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { agentLaunchPromptScopeKey } from '@/components/agent/AgentLaunchPromptComposer'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { changePrompt } from '@/components/native-chat/composer/editor/native-chat-prompt-editor.test-support'
import type { AgentPickerEntry } from '../../../../../../shared/agent-launch/picker/agent-launch-picker'
import * as launcher from './launch-agent-in-new-tab'
import { resetStructuredAgentLaunchRegistryForTests } from '../structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from '../structured-agent-session-launch-persistence'

const fileList = vi.hoisted(() => ({ files: [], loading: false, loadError: null }))
vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => fileList
}))

const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  worktreeId: 'wt-1',
  rows: [{ agent: 'claude', kind: 'cli', executionHostId: 'local' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  arguments: '',
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'launch-model', label: 'Launch model', efforts: [], isDefault: true }]
  }
}

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
})

function Menu({
  route,
  selected = entry
}: {
  route: 'menu' | 'search'
  selected?: AgentPickerEntry
}) {
  const launch = useTabAgentMenuLaunch({
    worktreeId: 'wt-1',
    groupId: 'group-1',
    onFocusTerminal: () => {}
  })
  return (
    <TooltipProvider>
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent>
          {route === 'search' ? (
            <TabBarCreateEntry
              worktreeId="wt-1"
              groupId="group-1"
              menuOpen
              agentPickerEntries={[selected]}
              onOpenEntry={async () => {}}
              onLaunchAgentOption={(option) =>
                option.row ? launch(option.row, option.setup, option.pickerEntry) : false
              }
            />
          ) : (
            <AgentLaunchPickerMenu entries={[selected]} runLaunch={launch} />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

function editor(): HTMLElement {
  return document.querySelector<HTMLElement>('[contenteditable][aria-multiline="true"]')!
}
function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name })
}

it('keeps direct row launch empty even when that workspace has an unsent launch draft', () => {
  updateNativeChatComposerDraft(
    agentLaunchPromptScopeKey(entry),
    { text: 'saved for setup only', images: [] },
    'immediate'
  )
  const actualLaunch = launcher.launchAgentInNewTab
  const dispatch = vi
    .spyOn(launcher, 'launchAgentInNewTab')
    .mockImplementation((args) => actualLaunch({ ...args, launchPlatform: 'win32' }))
  render(<Menu route="menu" />)
  fireEvent.click(document.querySelector('[role="menuitem"]')!)
  expect(mockCreateTab).toHaveBeenCalledOnce()
  expect(dispatch.mock.calls[0][0].prompt).toBeUndefined()
  expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(entry)).text).toBe(
    'saved for setup only'
  )
})

it('holds an actual clipboard-image paste until its save settles before launching', async () => {
  const actualLaunch = launcher.launchAgentInNewTab
  const dispatch = vi
    .spyOn(launcher, 'launchAgentInNewTab')
    .mockImplementation((args) => actualLaunch({ ...args, launchPlatform: 'linux' }))
  render(<Menu route="menu" />)
  fireEvent.click(document.querySelector('button[aria-label="Configure Claude"]')!)
  let finishSave: (path: string) => void = () => {}
  const save = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finishSave = resolve
      })
  )
  const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ...window.api, ui: { ...window.api?.ui, saveClipboardImageAsTempFile: save } }
  })
  try {
    const data = new DataTransfer()
    data.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
    fireEvent(
      editor(),
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    )
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    await act(async () => button('Launch terminal').click())
    expect(dispatch).not.toHaveBeenCalled()
    expect(mockCreateTab).not.toHaveBeenCalled()
    await act(async () => finishSave('/tmp/launch-image.png'))
    await waitFor(() =>
      expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(entry)).text).toContain(
        '/tmp/launch-image.png'
      )
    )
    await act(async () => button('Launch terminal').click())
    expect(mockCreateTab).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0][0].prompt).toContain('/tmp/launch-image.png')
  } finally {
    cleanup()
    if (previousApi) {
      Object.defineProperty(window, 'api', previousApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  }
})

it('returns setup input when explicit chat is refused before session admission', async () => {
  mockCreateSupport.mockResolvedValue({ supported: false, reason: 'Not available here' })
  render(<Menu route="search" />)
  fireEvent.change(document.querySelector('input')!, { target: { value: 'launch-model' } })
  fireEvent.click(document.querySelector('button[aria-label="Configure Claude"]')!)
  changePrompt(editor(), 'task before any session')
  await act(async () => button('Launch chat').click())
  await waitFor(() =>
    expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(entry)).text).toBe(
      'task before any session'
    )
  )
  expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
  expect(mockCreateTab).not.toHaveBeenCalled()
})
