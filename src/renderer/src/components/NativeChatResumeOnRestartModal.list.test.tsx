// @vitest-environment happy-dom

// The dialog's list as a control: initial focus, Select all, and keyboard movement.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import { TooltipProvider } from './ui/tooltip'
import {
  button,
  chatBox,
  failure,
  namedBox,
  offered
} from './native-chat-resume-on-restart-modal.test-support'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import { _resetNativeChatRestartOffer } from './native-chat-resume-on-restart-store'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn(async () => true)
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

/** Rows carry tooltips, so every mount needs the provider the app shell supplies. */
async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
}

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: true }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
})

// Left to the dialog, focus lands on the scrollable list and draws a ring around it.
it('opens with focus on the resume action', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  expect(document.activeElement?.textContent?.trim()).toBe('Resume 2 chats')
})

it('uses the sidebar surface without a border around the resume list', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  const list = document.querySelector('[aria-label="Chats that would be resumed"]')
  expect(list).not.toBeNull()
  expect(list?.classList.contains('bg-worktree-sidebar')).toBe(true)
  expect(list?.classList.contains('border')).toBe(false)
})

// The resume list is a tree; it keeps the list's accessible name.
it('exposes the list as a named tree of leveled items', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  const tree = document.querySelector('[role="tree"][aria-label="Chats that would be resumed"]')
  expect(tree).not.toBeNull()
  expect(
    document.querySelector('[role="group"][aria-label="Chats that would be resumed"]')
  ).toBeNull()
  const levels = [...tree!.querySelectorAll('[role="treeitem"]')].map((item) =>
    item.getAttribute('aria-level')
  )
  // Select all, then this workspace (no project the store knows) and its two chats.
  expect(levels).toEqual(['1', '1', '2', '2'])
  // The one divider sits under Select all.
  const selectAllItem = namedBox('Select all chats').closest('[role="treeitem"]')
  expect(selectAllItem?.parentElement?.classList.contains('border-b')).toBe(true)
})

it('folds the focused node with Left and opens it with Right, keeping focus and ticks', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  const workspace = namedBox('Select all chats in workspace')
  const press = async (key: string) =>
    act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  await act(async () => chatBox('a').click())
  workspace.focus()

  await press('ArrowLeft')
  expect(workspace.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('[aria-label*="Prompt a"]')).toBeNull()
  expect(document.activeElement).toBe(workspace)
  // Left again on a closed node does nothing.
  await press('ArrowLeft')
  expect(workspace.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false')

  await press('ArrowRight')
  expect(workspace.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
  expect(chatBox('a').getAttribute('aria-checked')).toBe('false')
  expect(chatBox('b').getAttribute('aria-checked')).toBe('true')
  expect(button('Resume 1 chat')).toBeTruthy()
})

it('keeps initial focus inside the dialog with no resumable chats', async () => {
  rpc.mockResolvedValue({ sessions: [], failed: [failure('b')] })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => requestNativeChatResumeOnRestartDialog())
  const dialog = document.querySelector('[role="dialog"]')
  expect(button('Resume 0 chats').disabled).toBe(true)
  expect(dialog).not.toBeNull()
  expect(dialog?.contains(document.activeElement)).toBe(true)
})

it('keeps initial focus inside the dialog when reopened during resume', async () => {
  const continued = Promise.withResolvers<unknown>()
  rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartResumable'
      ? Promise.resolve({ sessions: offered })
      : continued.promise
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  const opener = button('Resuming chats 0/2')
  await act(async () => {
    opener.focus()
    opener.click()
  })
  const dialog = document.querySelector('[role="dialog"]')
  expect(button('Resuming…').disabled).toBe(true)
  expect(dialog).not.toBeNull()
  expect(dialog?.contains(document.activeElement)).toBe(true)
  await act(async () => continued.resolve({ sessions: [], failed: [], resumed: [], continued: [] }))
})

it('starts the list with a tri-state Select all that counts the selection', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  const list = document.querySelector('[aria-label="Chats that would be resumed"]')!
  const selectAll = namedBox('Select all chats')
  // First row of the list, in the same left column as every other checkbox.
  expect(list.querySelector('[role="checkbox"]')).toBe(selectAll)
  expect(selectAll.closest('label')?.firstElementChild?.contains(selectAll)).toBe(true)
  const count = () => selectAll.closest('label')?.querySelector('.tabular-nums')?.textContent
  expect(selectAll.getAttribute('aria-checked')).toBe('true')
  expect(count()).toBe('2 of 2 selected')

  await act(async () => chatBox('a').click())
  expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
  expect(count()).toBe('1 of 2 selected')

  await act(async () => selectAll.click())
  expect(chatBox('a').getAttribute('aria-checked')).toBe('true')
  expect(button('Resume 2 chats').disabled).toBe(false)

  await act(async () => selectAll.click())
  expect(selectAll.getAttribute('aria-checked')).toBe('false')
  expect(count()).toBe('0 of 2 selected')
  expect(button('Resume 0 chats').disabled).toBe(true)
})

it('leaves a failure a retry cannot fix out of Select all', async () => {
  rpc.mockResolvedValue({ sessions: [offered[0]], failed: [{ ...failure('b'), retryable: false }] })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => requestNativeChatResumeOnRestartDialog())
  const selectAll = namedBox('Select all chats')
  expect(selectAll.closest('label')?.textContent).toContain('1 of 1 selected')

  await act(async () => selectAll.click())
  await act(async () => selectAll.click())
  expect(chatBox('a').getAttribute('aria-checked')).toBe('true')
  expect(chatBox('b').getAttribute('aria-checked')).toBe('false')
  expect(button('Resume 1 chat').disabled).toBe(false)
})

it('disables Select all and the workspace checkbox while a resume runs', async () => {
  const continued = Promise.withResolvers<unknown>()
  rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartResumable'
      ? Promise.resolve({ sessions: offered })
      : continued.promise
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  const list = document.querySelector('[aria-label="Chats that would be resumed"]')!
  const boxes = [...list.querySelectorAll('[role="checkbox"]')]
  expect(boxes).toHaveLength(2)
  for (const box of boxes) {
    expect(box.hasAttribute('disabled')).toBe(true)
  }
  await act(async () => continued.resolve({ sessions: [], failed: [], resumed: [], continued: [] }))
})

it('moves between the list’s checkboxes with the arrow keys', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  // This workspace has no repo the store knows, so no project row sits between.
  const order = [
    namedBox('Select all chats'),
    namedBox('Select all chats in workspace'),
    chatBox('a'),
    chatBox('b')
  ]
  const press = async (key: string) =>
    act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  order[0]!.focus()
  for (const next of order.slice(1)) {
    await press('ArrowDown')
    expect(document.activeElement).toBe(next)
  }
  // The last checkbox is the end of the list: focus never leaves it for the footer.
  await press('ArrowDown')
  expect(document.activeElement).toBe(order[3])
  await press('ArrowUp')
  expect(document.activeElement).toBe(order[2])
})

async function pressOn(element: Element, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

// Tab lands on the tree itself; its arrows must lead into the rows from there.
it('enters the tree from its own Tab stop with the arrow, Home and End keys', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  const tree = document.querySelector<HTMLElement>('[role="tree"]')!
  const first = namedBox('Select all chats')
  const last = chatBox('b')

  for (const [key, expected] of [
    ['ArrowDown', first],
    ['Home', first],
    ['ArrowUp', last],
    ['End', last]
  ] as const) {
    tree.focus()
    await pressOn(tree, key)
    expect(document.activeElement).toBe(expected)
  }
  // From a row, Home and End jump to the ends too.
  await pressOn(last, 'Home')
  expect(document.activeElement).toBe(first)
  await pressOn(first, 'End')
  expect(document.activeElement).toBe(last)
})

// Chromium focuses a pressed button; the keyboard must not be stranded on the arrow.
it('hands focus from a pressed arrow to its row’s checkbox', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  const workspace = namedBox('Select all chats in workspace')
  const arrow = workspace
    .closest('[role="treeitem"]')!
    .querySelector<HTMLButtonElement>('button[aria-expanded]')!

  arrow.focus()
  await act(async () => arrow.click())
  expect(arrow.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(workspace)
  await pressOn(workspace, 'ArrowRight')
  expect(arrow.getAttribute('aria-expanded')).toBe('true')
  await pressOn(workspace, 'ArrowDown')
  expect(document.activeElement).toBe(chatBox('a'))
})
