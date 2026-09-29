import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConversationKnowledgeIndexProgress } from './ConversationKnowledgeIndexProgress'

describe('ConversationKnowledgeIndexProgress', () => {
  it('shows the active agent session, queue, failures, and a stop action', () => {
    const markup = renderToStaticMarkup(
      <ConversationKnowledgeIndexProgress
        status={{
          state: 'running',
          total: 6,
          completed: 2,
          failed: 1,
          activeSession: {
            agent: 'claude',
            sessionId: 'current',
            title: 'Build source-backed knowledge search'
          }
        }}
        disabled={false}
        onGenerateUpdates={vi.fn()}
        onRegenerateAll={vi.fn()}
        onStop={vi.fn()}
      />
    )

    expect(markup).toContain('Build source-backed knowledge search')
    expect(markup).toContain('2')
    expect(markup).toContain('1')
    expect(markup).toContain('Stop generating')
    expect(markup).toContain('Queued')
  })

  it('shows stopped work separately from failures', () => {
    const markup = renderToStaticMarkup(
      <ConversationKnowledgeIndexProgress
        status={{ state: 'idle', total: 6, completed: 4, failed: 1, canceled: 1 }}
        disabled={false}
        onGenerateUpdates={vi.fn()}
        onRegenerateAll={vi.fn()}
        onStop={vi.fn()}
      />
    )

    expect(markup).toContain('Stopped')
    expect(markup).toContain('Failed')
  })
})
