// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import { useNativeChatSideChatCommand } from './use-native-chat-side-chat-command'

function sideChatCommand(draft: string) {
  const open = vi.fn().mockResolvedValue({ started: true })
  const completeItem = vi.fn()
  const transport = {
    sessionId: 'claude_source',
    onError: vi.fn(),
    capturePresentation: () => () => true,
    sideChat: { notReadyReason: null, open, reportForkPoint: vi.fn() }
  }
  const { result } = renderHook(() =>
    useNativeChatSideChatCommand({
      structuredTransport: transport,
      picker: {
        autocomplete: { mode: 'slash', dispatchable: true },
        isPickedSkill: () => false,
        completeItem
      },
      editor: {
        textareaRef: { current: { value: draft } },
        setCaret: vi.fn()
      }
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

it('sends a fully typed /btw on Enter instead of completing the row', () => {
  const { open, completeItem } = sideChatCommand('/btw')

  expect(open).toHaveBeenCalledWith('')
  expect(completeItem).not.toHaveBeenCalled()
})

it('completes a partly typed command so the question can follow', () => {
  const { open, completeItem } = sideChatCommand('/b')

  expect(completeItem).toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})
