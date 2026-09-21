// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'
import { MessageRow } from './NativeChatMessageRow'
import {
  NativeChatPayloadReaderContext,
  type NativeChatPayloadReader
} from './native-chat-payload-reader'

/** Test-only provider: the reader is a fixed test double, never rebuilt per render. */
function WithReader({ reader, children }: { reader: NativeChatPayloadReader; children: ReactNode }) {
  return (
    <NativeChatPayloadReaderContext.Provider value={reader}>{children}</NativeChatPayloadReaderContext.Provider>
  )
}

afterEach(cleanup)

const digest = 'a'.repeat(64)
const full = `${'line\n'.repeat(400)}CONSTRAINT-C after the head\nEND OF ARTIFACT`

function clippedBlocks(retrievable: boolean): NativeChatBlock[] {
  return [
    { type: 'tool-call', name: 'Bash', input: { command: 'cat artifact.md' }, state: 'completed' },
    {
      type: 'tool-result',
      output: 'line\nline\n… (36975 bytes)',
      clipped: { digest, byteLength: 36975, retrievable }
    }
  ]
}

describe('NativeChatFullContentButton', () => {
  it('offers and renders the complete original when the host retained it', async () => {
    const reader: NativeChatPayloadReader = {
      readFullPayload: vi.fn(async (requested: string, bytes: number) => {
        expect(requested).toBe(digest)
        expect(bytes).toBe(36975)
        return full
      })
    }
    render(
      <WithReader reader={reader}>
        <NativeChatToolRun blocks={clippedBlocks(true)} expandSignal={false} expandOverride />
      </WithReader>
    )
    fireEvent.click(screen.getByText('Result'))
    const button = await screen.findByRole('button', { name: 'Show full content' })
    fireEvent.click(button)
    await waitFor(() =>
      expect(screen.getByTestId('native-chat-full-content')).toHaveTextContent('CONSTRAINT-C after the head')
    )
    expect(reader.readFullPayload).toHaveBeenCalledTimes(1)
  })

  it('offers the complete original under clipped assistant prose', async () => {
    // A legacy-imported transcript bounds prose blocks too; the head must not
    // read as the whole message.
    const reader: NativeChatPayloadReader = {
      readFullPayload: vi.fn(async () => full)
    }
    render(
      <WithReader reader={reader}>
        <MessageRow
          message={{
            id: 'message',
            role: 'assistant',
            timestamp: 0,
            source: 'transcript',
            blocks: [
              {
                type: 'text',
                text: 'line\nline\n… (36975 bytes)',
                clipped: { digest, byteLength: 36975, retrievable: true }
              }
            ]
          }}
          expandSignal={false}
          onScrollMessageToTop={vi.fn()}
        />
      </WithReader>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Show full content' }))
    await waitFor(() =>
      expect(screen.getByTestId('native-chat-full-content')).toHaveTextContent('END OF ARTIFACT')
    )
  })

  it('shows the host refusal instead of the clipped head when retrieval fails', async () => {
    const reader: NativeChatPayloadReader = {
      readFullPayload: vi.fn(async () => {
        throw new Error('payload_integrity_failed')
      })
    }
    render(
      <WithReader reader={reader}>
        <NativeChatToolRun blocks={clippedBlocks(true)} expandSignal={false} expandOverride />
      </WithReader>
    )
    fireEvent.click(screen.getByText('Result'))
    fireEvent.click(await screen.findByRole('button', { name: 'Show full content' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('payload_integrity_failed')
    expect(screen.queryByTestId('native-chat-full-content')).toBeNull()
  })

  it('renders no affordance for a block the host did not retain, or outside a session pane', () => {
    const reader: NativeChatPayloadReader = { readFullPayload: vi.fn() }
    const { unmount } = render(
      <WithReader reader={reader}>
        <NativeChatToolRun blocks={clippedBlocks(false)} expandSignal={false} expandOverride />
      </WithReader>
    )
    fireEvent.click(screen.getByText('Result'))
    expect(screen.queryByRole('button', { name: 'Show full content' })).toBeNull()
    unmount()
    render(<NativeChatToolRun blocks={clippedBlocks(true)} expandSignal={false} expandOverride />)
    fireEvent.click(screen.getByText('Result'))
    expect(screen.queryByRole('button', { name: 'Show full content' })).toBeNull()
  })
})
