// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentJournalItemBodySchema } from '../../../../shared/agent-session-journal-schemas'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'

afterEach(cleanup)

function renderStatus(body: AgentJournalStatusItem) {
  const [message] = projectStructuredItemsToNativeChat([
    { itemId: 'notice', sequence: 1, revision: 1, observedAt: 1, body }
  ])
  return render(
    <MessageRow message={message!} expandSignal={false} onScrollMessageToTop={vi.fn()} />
  )
}

describe('notice rows', () => {
  it('renders a legacy notice with safe links and no assistant bubble', () => {
    const message: NativeChatMessage = {
      id: 'notice',
      role: 'system',
      source: 'transcript',
      timestamp: null,
      blocks: [
        {
          type: 'text',
          tone: 'notice',
          text: 'Please run `/login`. Read [enrollment](https://example.test/enroll). <script>bad()</script>'
        }
      ]
    }
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => event.preventDefault())
    const { container } = render(
      <MessageRow
        message={message}
        expandSignal={false}
        onScrollMessageToTop={vi.fn()}
        onLinkClick={onLinkClick}
      />
    )
    expect(screen.getByText('/login').tagName).toBe('CODE')
    expect(screen.getByText('/login').closest('a')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('.bg-muted\\/20')).not.toBeNull()
    const link = screen.getByRole('link', { name: 'enrollment' })
    fireEvent.click(link)
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), 'https://example.test/enroll')
    expect(container.querySelector('.rounded-tr-sm')).toBeNull()
  })

  it('renders compaction as a centered separator', () => {
    renderStatus({
      kind: 'status',
      text: 'Context compacted',
      presentation: 'compaction'
    })
    expect(screen.getByRole('separator', { name: 'Context compacted' })).toHaveClass(
      'text-muted-foreground'
    )
    expect(
      screen.getByText('Context compacted').parentElement?.querySelectorAll('.bg-border')
    ).toHaveLength(2)
  })
  it.each([
    ['warning', 'text-[color:var(--warning,#f59e0b)]'],
    ['error', 'text-destructive'],
    ['notice', 'text-muted-foreground']
  ])('renders %s using its existing color treatment', (tone, className) => {
    renderStatus({ kind: 'status', text: 'Readable notice', tone })
    expect(screen.getByText('Readable notice').closest('.space-y-2')).toHaveClass(className)
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
  it('renders future presentation and tone values as untinted text', () => {
    renderStatus({
      kind: 'status',
      text: 'Future readable text',
      tone: 'future-tone',
      presentation: 'future-presentation'
    })
    expect(screen.getByText('Future readable text').closest('.space-y-2')).toHaveClass(
      'text-foreground'
    )
    expect(screen.getByText('Future readable text').parentElement?.querySelector('svg')).toBeNull()
  })
})

describe('old-reader compatibility', () => {
  // Derive the prior status shape without its new optional hints.
  const statusSchema = AgentJournalItemBodySchema.options.find(
    (schema): schema is (typeof AgentJournalItemBodySchema.options)[5] =>
      schema.shape.kind.value === 'status'
  )!
  const oldStatusSchema = statusSchema.omit({ tone: true, presentation: true })
  it.each([
    { presentation: 'compaction' },
    { presentation: 'plan-document' },
    { tone: 'warning' },
    { tone: 'error' },
    { tone: 'notice' },
    { tone: 'future-tone', presentation: 'future-presentation' }
  ])('accepts new metadata and still renders text with an old reader: %j', (metadata) => {
    const body = {
      kind: 'status',
      text: 'Text survives version skew',
      ...metadata
    }
    expect(AgentJournalItemBodySchema.safeParse(body).success).toBe(true)
    const oldBody = oldStatusSchema.parse(body) as AgentJournalStatusItem
    expect(oldBody).toEqual({ kind: 'status', text: body.text })
    renderStatus(oldBody)
    expect(screen.getByText(body.text)).toBeInTheDocument()
  })
})
