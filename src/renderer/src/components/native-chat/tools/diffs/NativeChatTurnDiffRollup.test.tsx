// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { render } from '../../messages/actions/native-chat-tooltip-test-harness'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../../messages/disclosure/native-chat-disclosure-store'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  nativeChatTurnDiffs,
  type NativeChatTurnDiff
} from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { NativeChatTurnDiffRollup } from './NativeChatTurnDiffRollup'

function editMessage(messageId: string, fileCount: number): NativeChatMessage {
  const blocks: NativeChatMessage['blocks'] = []
  for (let index = 0; index < fileCount; index += 1) {
    const callId = `${messageId}-${index}`
    blocks.push(
      {
        type: 'tool-call',
        name: 'Edit',
        state: 'completed',
        callId,
        input: {
          file_path: `/src/file-${index}.ts`,
          old_string: `before-${index}`,
          new_string: `after-${index}`
        }
      },
      { type: 'tool-result', output: 'Updated', callId }
    )
  }
  return { id: messageId, role: 'assistant', source: 'transcript', timestamp: 1, blocks }
}

function diffOf(messages: NativeChatMessage[], turnKey: string): NativeChatTurnDiff {
  const diff = nativeChatTurnDiffs(
    messages,
    messages.map(() => turnKey)
  ).get(turnKey)
  if (!diff) {
    throw new Error('Expected file changes in the transcript')
  }
  return diff
}

const changes = diffOf([editMessage('edits', 23)], 'edits')
const otherTurn = diffOf([editMessage('other-edits', 1)], 'other-edits')

function Harness({ show = true, diff = changes }: { show?: boolean; diff?: NativeChatTurnDiff }) {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      {show ? <NativeChatTurnDiffRollup diff={diff} /> : null}
      <NativeChatTurnDiffRollup diff={otherTurn} />
    </NativeChatDisclosureContext.Provider>
  )
}

afterEach(cleanup)

it('folds a turn to its summary while retaining revealed files and patches across row remounts', async () => {
  const { rerender } = render(<Harness />)
  const summary = screen.getByRole('button', { name: /23 changed files/ })
  expect(summary).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('button', { name: '/src/file-0.ts +1 -1' })).toBeNull()

  fireEvent.click(summary)
  fireEvent.click(screen.getByRole('button', { name: /Show .* more/ }))
  expect(screen.getByRole('button', { name: '/src/file-22.ts +1 -1' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '/src/file-0.ts +1 -1' }))
  expect(screen.getByText('after-0')).toBeVisible()
  expect(screen.getByRole('button', { name: /1 changed file / })).toHaveAttribute(
    'aria-expanded',
    'false'
  )

  fireEvent.click(summary)
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: '/src/file-22.ts +1 -1' })).toBeNull()
    expect(screen.queryByText('after-0')).toBeNull()
  })
  expect(summary).toHaveAttribute('aria-expanded', 'false')

  rerender(<Harness show={false} />)
  rerender(<Harness />)
  const remountedSummary = screen.getByRole('button', { name: /23 changed files/ })
  expect(remountedSummary).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(remountedSummary)
  expect(screen.getByRole('button', { name: '/src/file-22.ts +1 -1' })).toBeVisible()
  expect(screen.getByRole('button', { name: '/src/file-0.ts +1 -1' })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
  expect(screen.getByText('after-0')).toBeVisible()
})

it('keeps an opened summary open when earlier history loads into its turn', () => {
  const tail = editMessage('tail', 2)
  const { rerender } = render(<Harness diff={diffOf([tail], 'turn')} />)
  fireEvent.click(screen.getByRole('button', { name: /2 changed files/ }))
  rerender(<Harness diff={diffOf([editMessage('history', 2), tail], 'turn')} />)
  expect(screen.getByRole('button', { name: /2 changed files/ })).toHaveAttribute(
    'aria-expanded',
    'true'
  )
})
