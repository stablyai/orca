// @vitest-environment happy-dom
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { entry, host, root, onUse } from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { agentLaunchPromptScopeKey } from './AgentLaunchPromptComposer'
import { changePrompt, promptEditor } from '../native-chat/native-chat-prompt-editor.test-support'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft
} from '../native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../native-chat/native-chat-composer-draft-storage'

beforeEach(() => clearNativeChatComposerDraftsForTests())

const launchEntry = { ...entry, worktreeId: 'wt-1' }

function prompt(): HTMLElement {
  return host.querySelector<HTMLElement>('[contenteditable][aria-multiline="true"]')!
}

function launchButton(label: string): HTMLButtonElement {
  return [...host.querySelectorAll('button')].find((button) => button.textContent === label)!
}

it('launches with the typed first prompt from Enter or either Launch button, and without one as before', async () => {
  const storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupPanel entry={launchEntry} onUse={onUse} />
      </TooltipProvider>
    )
  )
  expect(prompt().getAttribute('aria-label')).toBe(
    'Add a prompt (optional): / for skills, @ for files'
  )

  // Enter launches the panel's default way.
  changePrompt(prompt(), 'fix the flaky test')
  await act(async () => {
    fireEvent.keyDown(prompt(), { key: 'Enter', keyCode: 13, isComposing: false })
  })
  await waitFor(() =>
    expect(onUse).toHaveBeenLastCalledWith(
      expect.objectContaining({ surface: 'terminal', prompt: 'fix the flaky test' })
    )
  )
  await waitFor(() =>
    expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(launchEntry)).text).toBe('')
  )

  // The other Launch button sends the prompt its own way.
  changePrompt(prompt(), 'review the diff')
  await act(async () => launchButton('Launch chat').click())
  await waitFor(() =>
    expect(onUse).toHaveBeenLastCalledWith(
      expect.objectContaining({ surface: 'chat', prompt: 'review the diff' })
    )
  )

  // Nothing typed: the launch is exactly today's.
  await waitFor(() =>
    expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(launchEntry)).text).toBe('')
  )
  await act(async () => launchButton('Launch terminal').click())
  expect(onUse).toHaveBeenLastCalledWith(expect.not.objectContaining({ prompt: expect.anything() }))
  expect(onUse).toHaveBeenCalledTimes(3)

  // A typed prompt lives in memory for this app session only.
  changePrompt(prompt(), 'kept until launch')
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(launchEntry)).text).toBe(
    'kept until launch'
  )
  expect(storage.drafts.size).toBe(0)
  setNativeChatComposerDraftStorageForTests(null)
})

it.each(['composer', 'arguments', 'model', 'chat', 'terminal'])(
  'submits the same optional input through %s, holding pending-only content',
  async (trigger) => {
    const selected = {
      ...launchEntry,
      terminal: { ...launchEntry.terminal, model: 'selected-model' },
      catalog: {
        origin: 'probe' as const,
        fetchedAt: 1,
        models: [{ id: 'selected-model', label: 'Selected model', efforts: [], isDefault: true }]
      }
    }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={selected} onUse={onUse} />
        </TooltipProvider>
      )
    )
    const scope = agentLaunchPromptScopeKey(selected)
    const { addNativeChatPendingAttachment, settleNativeChatPendingAttachmentReferences } =
      await import('../native-chat/native-chat-pending-attachment-cache')
    const submit = async () => {
      await act(async () => {
        if (trigger === 'chat' || trigger === 'terminal') {
          launchButton(trigger === 'chat' ? 'Launch chat' : 'Launch terminal').click()
        } else {
          const target =
            trigger === 'composer'
              ? prompt()
              : trigger === 'arguments'
                ? host.querySelector('textarea')!
                : host.querySelector('input[aria-label="Search models"]')!
          fireEvent.keyDown(target, { key: 'Enter', keyCode: 13 })
        }
      })
    }
    act(() =>
      addNativeChatPendingAttachment(scope, { id: 'pending-file', path: '', pending: true })
    )
    await submit()
    expect(onUse).not.toHaveBeenCalled()
    act(() => {
      settleNativeChatPendingAttachmentReferences(scope, [
        { id: 'pending-file', path: '/repo/notes.txt' }
      ])
    })
    await submit()
    expect(onUse).toHaveBeenCalledOnce()
    expect(onUse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: '@/repo/notes.txt',
        surface: trigger === 'chat' ? 'chat' : 'terminal'
      })
    )
    await waitFor(() => expect(readNativeChatComposerDraft(scope).text).toBe(''))
    changePrompt(prompt(), '   ')
    await submit()
    expect(onUse).toHaveBeenCalledTimes(2)
    expect(onUse).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ prompt: expect.anything() })
    )
    await waitFor(() => expect(readNativeChatComposerDraft(scope).text).toBe(''))
  }
)

it('keeps launch drafts with their stable workspace host through remounts and inventory refresh', async () => {
  const a: AgentPickerEntry = {
    ...launchEntry,
    rows: [{ agent: 'claude' as const, kind: 'cli' as const, executionHostId: 'local' }]
  }
  const b: AgentPickerEntry = {
    ...a,
    rows: [{ agent: 'claude', kind: 'cli', executionHostId: 'runtime:server-b' }]
  }
  const show = (selected: AgentPickerEntry) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            key={agentLaunchPromptScopeKey(selected)}
            entry={selected}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
  show(a)
  changePrompt(prompt(), 'inspect @src/private-a.ts')
  show(b)
  expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(b)).text).toBe('')
  changePrompt(prompt(), 'inspect @src/private-b.ts')
  show({ ...a, ownerKey: 'refreshed-defaults-and-catalog' })
  expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(a)).text).toBe(
    'inspect @src/private-a.ts'
  )
  expect(prompt().textContent).toContain('private-a.ts')
  await act(async () => launchButton('Launch chat').click())
  expect(onUse).toHaveBeenLastCalledWith(
    expect.objectContaining({ prompt: 'inspect @src/private-a.ts' })
  )
  expect(readNativeChatComposerDraft(agentLaunchPromptScopeKey(b)).text).toBe(
    'inspect @src/private-b.ts'
  )
})

it.each(['/model', '/effort', '/resume'])(
  'does not advertise the session-only %s action before launch',
  async (command) => {
    const selected = { ...launchEntry, agent: 'codex' as const }
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel entry={selected} onUse={onUse} />
        </TooltipProvider>
      )
    )
    changePrompt(prompt(), command)
    act(() => promptEditor(prompt()).commands.setTextSelection(command.length + 1))
    await act(async () => {})
    expect(document.querySelector('[role="option"]:not([cmdk-item])')).toBeNull()
    expect(onUse).not.toHaveBeenCalled()
    changePrompt(prompt(), '/goal')
    act(() => promptEditor(prompt()).commands.setTextSelection(6))
    await waitFor(() =>
      expect(document.querySelector('[role="option"]:not([cmdk-item])')?.textContent).toContain(
        '/goal'
      )
    )
  }
)
