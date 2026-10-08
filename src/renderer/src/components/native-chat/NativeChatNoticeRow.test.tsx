// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session-journal-types'
import { MessageRow } from './NativeChatMessageRow'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'

afterEach(cleanup)

function orcaStopView(
  hostLabel: string | null,
  continueAvailable: boolean
): NativeChatOrcaStopView {
  return { hostLabel, continueAvailable }
}

function renderStatus(
  body: AgentJournalStatusItem,
  hostLabel: string | null = null,
  continueAvailable = false
) {
  const [message] = projectStructuredItemsToNativeChat([
    {
      itemId: 'notice',
      sequence: 1,
      revision: 1,
      observedAt: 1,
      body,
      turnScope: { kind: 'turn', turnItemId: 'cut-turn' }
    }
  ])
  const view = orcaStopView(hostLabel, continueAvailable)
  return render(
    <NativeChatOrcaStopContext.Provider value={view}>
      <MessageRow message={message!} expandSignal={false} onScrollMessageToTop={vi.fn()} />
    </NativeChatOrcaStopContext.Provider>
  )
}

const LEGACY_TEXT =
  'Codex stopped while this response was in progress. You can continue in this conversation.'

function orcaStopRow(cause: string): AgentJournalStatusItem {
  return {
    kind: 'status',
    text: LEGACY_TEXT,
    tone: 'error',
    presentation: 'orca-stop',
    orcaStop: { cause }
  }
}

describe('the row an Orca stop leaves', () => {
  it.each([
    ['update', 'Orca on studio-mac restarted for an update while this response was in progress.'],
    ['quit', 'Orca on studio-mac was closed while this response was in progress.'],
    ['crash', 'Orca on studio-mac stopped unexpectedly while this response was in progress.']
  ])('names a %s and the machine, muted', (cause, sentence) => {
    renderStatus(orcaStopRow(cause), 'studio-mac')
    const row = screen.getByText(`${sentence} You can continue in this conversation.`)
    expect(row.parentElement?.parentElement).toHaveClass('text-muted-foreground')
    expect(screen.queryByText(LEGACY_TEXT)).toBeNull()
  })

  it('leaves the way on to Continue wherever its host can continue a cut', () => {
    renderStatus(orcaStopRow('update'), 'studio-mac', true)
    expect(
      screen.getByText(
        'Orca on studio-mac restarted for an update while this response was in progress.'
      )
    ).toBeInTheDocument()
  })

  // A client that re-words unnamed host rows keeps this row's presentation and cause, neutral.
  it('stays neutral, naming the cause, as a reader that re-presented it neutral hands it on', () => {
    // Its words and tone replaced, and the failure fact the old words came from dropped with them.
    const represented: AgentJournalStatusItem = {
      kind: 'status',
      text: 'This response was interrupted. You can continue in this conversation.',
      tone: 'notice',
      presentation: 'orca-stop',
      orcaStop: { cause: 'crash' }
    }
    renderStatus(represented, 'studio-mac', true)
    expect(
      screen.getByText(
        'Orca on studio-mac stopped unexpectedly while this response was in progress.'
      ).parentElement?.parentElement
    ).toHaveClass('text-muted-foreground')
    cleanup()
    renderStatus(represented, null, true)
    expect(
      screen.getByText('This response was interrupted. You can continue in this conversation.')
        .parentElement?.parentElement
    ).toHaveClass('text-muted-foreground')
  })

  it('keeps the host words for a cause this build does not know', () => {
    renderStatus(orcaStopRow('power-loss'), 'studio-mac')
    expect(screen.getByText(LEGACY_TEXT)).toBeInTheDocument()
  })

  it('keeps the host words when the chat has no machine to name, muted all the same', () => {
    renderStatus(orcaStopRow('update'), null)
    expect(screen.getByText(LEGACY_TEXT).parentElement?.parentElement).toHaveClass(
      'text-muted-foreground'
    )
  })

  it('keeps the host words for a stop Orca did not cause', () => {
    const { orcaStop: _orcaStop, presentation: _presentation, ...agentExit } = orcaStopRow('update')
    renderStatus(agentExit, 'studio-mac')
    expect(screen.getByText(LEGACY_TEXT).parentElement?.parentElement).toHaveClass(
      'text-destructive'
    )
  })
})

describe('notice rows', () => {
  it('renders compaction as a centered separator', () => {
    renderStatus({ kind: 'status', text: 'Context compacted', presentation: 'compaction' })
    expect(screen.getByRole('separator', { name: 'Context compacted' })).toHaveClass(
      'text-muted-foreground'
    )
    expect(
      screen.getByText('Context compacted').parentElement?.querySelectorAll('.bg-border')
    ).toHaveLength(2)
  })
  it('renders a plan as readable markdown in the card primitive', () => {
    renderStatus({
      kind: 'status',
      text: '# Steps\n\nA **readable** document.',
      presentation: 'plan-document'
    })
    expect(screen.getByText('Plan').closest('[data-slot="card"]')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument()
    expect(screen.getByText('readable').tagName).toBe('STRONG')
    expect(screen.getByText('readable').closest('[data-slot="card-content"]')).toHaveClass(
      'text-sm',
      'text-foreground'
    )
  })
  it('shows provider notice text once while retaining its diagnostic disclosure', () => {
    renderStatus({
      kind: 'status',
      text: 'Check the configuration',
      tone: 'warning',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:warning',
        payload: {
          head: '{"message":"Check the configuration"}',
          byteLength: 37,
          digest: 'digest',
          truncated: false
        }
      }
    })
    expect(screen.getAllByText('Check the configuration')).toHaveLength(1)
    const disclosure = screen.getByText('Details').closest('details')
    expect(disclosure?.querySelector('summary')).not.toHaveTextContent('Check the configuration')
    expect(disclosure?.querySelector('pre')).toHaveTextContent('Check the configuration')
  })
  it('keeps the column layout of command output in monospace', () => {
    const text =
      'Context Usage\n⛁ ⛁ ⛶   gpt-4o · 16.6k/128k tokens (13%)\n      ⛁ Skills: 304 tokens'
    render(
      <MessageRow
        message={{
          id: 'command-output',
          role: 'system',
          blocks: [{ type: 'text', text, presentation: 'command-output' }],
          timestamp: 1,
          source: 'transcript'
        }}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    )
    const output = screen.getByText(/Context Usage/)
    expect(output.tagName).toBe('PRE')
    expect(output).toHaveClass('font-mono')
    expect(output.textContent).toBe(text)
  })
  // The host's text is only for a client that can't word the row itself.
  it.each([
    ['history-repaired', "Part of this chat's history couldn't be loaded."],
    ['history-item-too-large', 'This part of the chat was too large to show.']
  ])('words a %s row itself, as a muted status line', (presentation, words) => {
    renderStatus({ kind: 'status', text: 'Words an older host wrote', presentation })
    expect(screen.getByText(words)).toHaveClass('text-muted-foreground', 'text-sm')
    expect(screen.queryByText('Words an older host wrote')).toBeNull()
  })
})
