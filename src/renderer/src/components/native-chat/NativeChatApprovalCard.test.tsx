// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { chatApprovalFromJournal } from '../../../../shared/native-chat/input/native-chat-interactive-prompt'
import type { AgentJournalApprovalItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

afterEach(cleanup)

describe('NativeChatApprovalCard', () => {
  it('previews file changes, keeps access visible, and expands the full proposal without gating approval', () => {
    const onChoose = vi.fn()
    const body: AgentJournalApprovalItem = {
      kind: 'approval',
      title: 'Apply file changes?',
      decisionReason: 'Write outside the sandbox.',
      description: 'Write access: /repo',
      blockedPath: '/outside/second.ts',
      detail: 'update /repo/src/app.ts\n\n@@ -1 +1 @@\n-old\n+new\n/outside/second.ts',
      options: [{ id: 'accept', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
    render(<NativeChatApprovalCard approval={chatApprovalFromJournal(body)} onChoose={onChoose} />)
    expect(screen.getByText('Write access: /repo')).toBeTruthy()
    expect(screen.getByText('Write outside the sandbox.')).toBeTruthy()
    const toggle = screen.getByRole('button', { name: 'Details' })
    const shownDetail = () =>
      document.querySelector('[data-native-chat-approval-detail]')?.textContent
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(shownDetail()).toBe('update /repo/src/app.ts\n\n@@ -1 +1 @@\n-old…')
    expect(screen.getByText('/outside/second.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(shownDetail()).toBe(body.detail)
    expect(document.querySelectorAll('[data-native-chat-approval-detail]')).toHaveLength(1)
    expect(screen.getByText('/outside/second.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
    expect(onChoose.mock.calls).toEqual([['accept'], ['accept']])
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(shownDetail()).not.toContain('+new')
  })

  it.each([
    ['Run a command?', 'git status'],
    ['Allow Write?', '{\n  "file_path": "/repo/a.ts",\n  "content": "hi"\n}'],
    ['Allow tool?', 'Read /repo/a.ts'],
    ['Confirm?', 'Continue with the requested operation?']
  ])(
    'keeps compact operation context visible for %s without a redundant toggle',
    (title, detail) => {
      render(
        <NativeChatApprovalCard approval={{ title, detail, options: [] }} onChoose={() => {}} />
      )
      expect(document.querySelector('[data-native-chat-approval-detail]')?.textContent).toBe(detail)
      expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    }
  )

  it('starts a replacement request closed at the caller request-key boundary', () => {
    const approval = { title: 'Run a command?', detail: 'one\ntwo\nthree\nfour\nfive', options: [] }
    const view = render(
      <NativeChatApprovalCard key="item-1:1" approval={approval} onChoose={() => {}} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    view.rerender(<NativeChatApprovalCard key="item-1:2" approval={approval} onChoose={() => {}} />)
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(document.querySelector('[data-native-chat-approval-detail]')?.textContent).not.toContain(
      'five'
    )
  })

  it.each([
    ['ordinary context', 200, 0, 0],
    ['oversized context', 488, 200, 200],
    ['visible row after tabbing through oversized context', 4392, 4184, 4104]
  ] as const)(
    'preserves the opening viewport and restores the closing row with %s',
    (_case, rowBottom, openingOffset, closingOffset) => {
      render(
        <NativeChatApprovalCard
          approval={{ title: 'Allow command?', detail: 'one\ntwo\nthree\nfour\nfive', options: [] }}
          onChoose={() => {}}
        />
      )
      const toggle = screen.getByRole('button', { name: 'Details' })
      const content = document.querySelector<HTMLElement>('[data-native-chat-approval-content]')!
      Object.defineProperty(content, 'clientHeight', { value: 288 })
      vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect())
      vi.spyOn(toggle, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, rowBottom - content.scrollTop - 36, 0, 36)
      )
      content.scrollTop = openingOffset
      toggle.focus()
      fireEvent.click(toggle)
      expect(content.scrollTop).toBe(openingOffset)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      content.scrollTop = 780
      fireEvent.click(toggle)
      expect(content.scrollTop).toBe(closingOffset)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(toggle)
    }
  )
})
