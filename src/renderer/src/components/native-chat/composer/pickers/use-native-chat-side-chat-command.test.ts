// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/native-chat-picker-items'
import { useNativeChatSideChatCommand } from './use-native-chat-side-chat-command'

function sideChatCommand(notReadyReason: string | null = null) {
  const open = vi.fn().mockResolvedValue({ started: true })
  const completeItem = vi.fn()
  const transport = {
    sessionId: 'claude_source',
    onError: vi.fn(),
    capturePresentation: () => () => true,
    sideChat: { notReadyReason, open, reportForkPoint: vi.fn() }
  }
  const { result } = renderHook(() =>
    useNativeChatSideChatCommand({
      structuredTransport: transport,
      picker: {
        autocomplete: { mode: 'slash', dispatchable: true },
        isPickedSkill: () => false,
        completeItem
      },
      editor: { setCaret: vi.fn() }
    })
  )
  const btw: NativeChatPickerItem = {
    kind: 'command',
    id: 'command:btw',
    name: 'btw',
    token: '/btw',
    orcaOwned: true,
    skillCollision: false
  }
  const pick = vi.fn()
  result.current.interceptPick(pick)(btw)
  return { open, completeItem, pick }
}

// As the common pattern does: a pick, by Enter or click, leaves `/btw ` to add a question to.
it('completes the row on a pick, even when the command is already typed', () => {
  const { open, completeItem, pick } = sideChatCommand()

  expect(completeItem).toHaveBeenCalled()
  expect(pick).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it('ignores a pick of the row while side chats are unavailable', () => {
  const { open, completeItem, pick } = sideChatCommand('Available after the first reply.')

  expect(completeItem).not.toHaveBeenCalled()
  expect(pick).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})
