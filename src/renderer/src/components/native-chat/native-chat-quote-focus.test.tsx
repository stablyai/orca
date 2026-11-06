// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchPromptComposer } from '../agent/AgentLaunchPromptComposer'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './use-native-chat-context-menu'
import { clearNativeChatComposerDraftsForTests } from './native-chat-composer-draft-store'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'

const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [{ agent: 'claude', kind: 'cli', executionHostId: 'local' }],
  surfaces: ['chat'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' }
}

function Chat() {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const { menu, onContextMenuCapture, onPointerDownCapture } = useNativeChatContextMenu({
    rootRef,
    composerRef,
    showTerminalPaneActions: false,
    actions: { ...emptyNativeChatContextMenuActions, onPaste: () => {} }
  })
  return (
    <div
      ref={rootRef}
      onContextMenuCapture={onContextMenuCapture}
      onPointerDownCapture={onPointerDownCapture}
    >
      <div data-native-chat-scroll>
        <p data-native-chat-quote-source="">Reply to quote</p>
      </div>
      <AgentLaunchPromptComposer entry={entry} composerRef={composerRef} onLaunch={() => false} />
      {menu}
    </div>
  )
}

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

it('places the caret after the quote when Add to chat closes the context menu', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(0)
  render(<Chat />, { wrapper: TooltipProvider })
  const editor = document.querySelector<HTMLElement>('[contenteditable][aria-multiline="true"]')!
  await waitFor(() => expect(promptEditor(editor)).toBeDefined())
  const reply = screen.getByText('Reply to quote')
  window.getSelection()!.selectAllChildren(reply)
  fireEvent.contextMenu(reply)
  await screen.findByRole('menu')
  now.mockReturnValue(1000)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add to chat' }))

  expect(promptValue(editor)).toBe('> Reply to quote\n\n')
  expect(document.activeElement).toBe(editor)
  await act(async () => {})
  expect(document.activeElement).toBe(editor)
  expect(promptEditor(editor).state.selection.empty).toBe(true)
  expect(promptEditor(editor).state.selection.to).toBe(
    promptEditor(editor).state.doc.content.size - 1
  )
})
