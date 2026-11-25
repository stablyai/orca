// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
import { NativeChatApprovalCard } from '../prompts/NativeChatApprovalCard'
import { NativeChatQuestionCard } from '../prompts/NativeChatQuestionCard'
import {
  noteNativeChatSubagentParent,
  openNativeChatSubagent,
  useNativeChatOpenSubagent
} from './native-chat-open-subagent'
import { NativeChatSubagentSheet } from './NativeChatSubagentSheet'
import {
  NativeChatSubagentSheetLayer,
  NativeChatSubagentSheetPromptSlot
} from './NativeChatSubagentSheetLayer'

const PANE = 'tab-1:sheet'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  act(() => openNativeChatSubagent(PANE, null))
})

function Pane({
  promptAgentId = 'a1',
  children
}: {
  /** Whose prompt the card is; null for the main agent. */
  promptAgentId?: string | null
  children: React.ReactNode
}) {
  const open = useNativeChatOpenSubagent(PANE)
  return (
    <div data-native-chat-root className="relative">
      <NativeChatSubagentSheetLayer paneKey={PANE} sessionKey="session">
        {open ? (
          <NativeChatSubagentSheet
            paneKey={PANE}
            agentId={open.agentId}
            titleId="sheet-title"
            onClose={() => openNativeChatSubagent(PANE, null)}
          >
            <h2 id="sheet-title">Map streamed page RPC</h2>
          </NativeChatSubagentSheet>
        ) : null}
        <NativeChatSubagentSheetPromptSlot agentId={promptAgentId ?? undefined}>
          {children}
        </NativeChatSubagentSheetPromptSlot>
      </NativeChatSubagentSheetLayer>
    </div>
  )
}

function approval(onCancel: () => void) {
  return (
    <NativeChatApprovalCard
      approval={{
        title: 'Allow curl?',
        options: [
          { label: 'Allow', send: 'accept' },
          { label: 'Deny', send: 'decline' }
        ]
      }}
      onChoose={() => {}}
      onCancel={onCancel}
    />
  )
}

const tabsOrSpaces: AskPrompt = {
  questions: [
    {
      question: 'Tabs or spaces?',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }]
    }
  ]
}

it("closes the sheet on Esc from its subagent's own approval card, never cancelling the prompt", () => {
  const cancel = vi.fn()
  act(() => openNativeChatSubagent(PANE, 'a1'))
  render(<Pane>{approval(cancel)}</Pane>)
  const allow = screen.getByRole('button', { name: 'Allow' })
  expect(screen.getByRole('dialog').contains(allow)).toBe(true)

  allow.focus()
  fireEvent.keyDown(allow, { key: 'Escape' })

  expect(cancel).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps Esc on the card cancelling its prompt when no sheet is open', () => {
  const cancel = vi.fn()
  render(<Pane>{approval(cancel)}</Pane>)

  fireEvent.keyDown(screen.getByRole('button', { name: 'Allow' }), { key: 'Escape' })

  expect(cancel).toHaveBeenCalledTimes(1)
})

it("never answers the main agent's covered question with a digit pressed in the sheet", () => {
  vi.useFakeTimers()
  const answer = vi.fn()
  act(() => openNativeChatSubagent(PANE, 'a1'))
  render(
    <Pane promptAgentId={null}>
      <NativeChatQuestionCard
        prompt={tabsOrSpaces}
        onAnswer={answer}
        onCancel={() => {}}
        shouldFocus
      />
    </Pane>
  )

  fireEvent.keyDown(screen.getByRole('dialog'), { key: '1' })
  act(() => vi.runAllTimers())

  expect(answer).not.toHaveBeenCalled()
})

it("keeps a half-typed answer when the subagent's question moves into its opening sheet", () => {
  render(
    <Pane>
      <NativeChatQuestionCard
        prompt={{ questions: [{ question: 'Which branch?', multiSelect: false, options: [] }] }}
        onAnswer={() => {}}
        onCancel={() => {}}
      />
    </Pane>
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'release/2' } })

  act(() => openNativeChatSubagent(PANE, 'a1'))

  const field = screen.getByRole('textbox')
  expect(screen.getByRole('dialog').contains(field)).toBe(true)
  expect(field).toHaveProperty('value', 'release/2')
})

it("keeps focus in the sheet when Esc on a nested subagent's own approval goes up a level", () => {
  act(() => {
    openNativeChatSubagent(PANE, 'a1')
    openNativeChatSubagent(PANE, 'a4')
    noteNativeChatSubagentParent(PANE, 'a4', 'a1')
  })
  render(<Pane promptAgentId="a4">{approval(() => {})}</Pane>)
  const allow = screen.getByRole('button', { name: 'Allow' })
  allow.focus()

  fireEvent.keyDown(allow, { key: 'Escape' })

  const sheet = screen.getByRole('dialog')
  expect(sheet.contains(screen.getByRole('button', { name: 'Allow', hidden: true }))).toBe(false)
  expect(sheet.contains(document.activeElement)).toBe(true)
})

it("wraps Tab from the subagent's own prompt card back to the sheet's first control", () => {
  act(() => openNativeChatSubagent(PANE, 'a1'))
  render(<Pane>{approval(() => {})}</Pane>)
  const sheet = screen.getByRole('dialog')
  const deny = screen.getByRole('button', { name: 'Deny' })
  deny.focus()

  fireEvent.keyDown(deny, { key: 'Tab' })

  expect(sheet.contains(document.activeElement)).toBe(true)
  expect(document.activeElement).not.toBe(deny)
})

it("takes focus back into the sheet when answering disables the subagent's focused prompt", async () => {
  act(() => openNativeChatSubagent(PANE, 'a1'))
  render(<Pane>{approval(() => {})}</Pane>)
  const allow = screen.getByRole('button', { name: 'Allow' })
  allow.focus()

  // Chromium blurs a focused button as it becomes disabled.
  allow.blur()
  allow.setAttribute('disabled', '')
  await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))

  expect(document.activeElement).toBe(screen.getByRole('dialog'))
})

it("takes focus back into the sheet when the subagent's focused prompt card unmounts", async () => {
  act(() => openNativeChatSubagent(PANE, 'a1'))
  const { rerender } = render(<Pane>{approval(() => {})}</Pane>)
  screen.getByRole('button', { name: 'Allow' }).focus()

  rerender(<Pane>{null}</Pane>)
  await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))

  expect(document.activeElement).toBe(screen.getByRole('dialog'))
})
