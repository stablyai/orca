// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { projectStructuredItemToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow } from './NativeChatMessageRow'
import { i18n } from '@/i18n/i18n'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

function renderStatus(body: AgentJournalStatusItem) {
  const message = projectStructuredItemToNativeChat({
    itemId: 'notice',
    sequence: 1,
    revision: 1,
    observedAt: 1,
    body
  })
  if (!message) {
    throw new Error('expected notice')
  }
  render(
    <TooltipProvider>
      <MessageRow
        message={message}
        agentName="Claude"
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
      />
    </TooltipProvider>
  )
}

it.each([
  ['en', 'Claude switched models: Claude Opus 5.5 → Claude Opus 4.8.'],
  ['ru', 'Claude переключил модель: Claude Opus 5.5 → Claude Opus 4.8.']
])(
  'renders the saved fallback as a readable %s notice instead of unknown JSON',
  async (locale, words) => {
    await i18n.changeLanguage(locale)
    const head = JSON.stringify({
      type: 'fallback',
      from: { model: 'claude-opus-5-5' },
      to: { model: 'claude-opus-4-8' }
    })
    renderStatus({
      kind: 'status',
      text: 'Claude sent content Orca cannot display yet',
      providerFrame: {
        provider: 'claude',
        kind: 'message:assistant:content:fallback',
        payload: { head, byteLength: head.length, digest: 'fixture', truncated: false }
      }
    })
    expect(screen.getByText(words)).toBeInTheDocument()
    expect(screen.queryByText('Claude sent content Orca cannot display yet')).toBeNull()
    expect(screen.queryByText(head)).toBeNull()
  }
)
