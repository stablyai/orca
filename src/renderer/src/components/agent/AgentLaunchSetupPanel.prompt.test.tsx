// @vitest-environment happy-dom
import { entry, host, root, onUse } from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { agentLaunchPromptScopeKey } from './AgentLaunchPromptComposer'
import { changePrompt } from '../native-chat/native-chat-prompt-editor.test-support'
import { readNativeChatComposerDraft } from '../native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '../native-chat/native-chat-composer-draft-storage'

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
  act(() => launchButton('Launch terminal').click())
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
