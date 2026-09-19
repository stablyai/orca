/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeHoverCardBody, type WorktreeHoverSession } from './worktree-hover-card-body'
import type { WorktreeHoverFacts } from './worktree-hover-facts'

vi.mock('./comment-markdown-lazy', () => ({
  CommentMarkdownAsync: ({ content }: { content: string }) => (
    <div data-hover-markdown="">{content}</div>
  ),
  preloadCommentMarkdown: () => {}
}))

function facts(overrides: Partial<WorktreeHoverFacts> = {}): WorktreeHoverFacts {
  return {
    title: 'Mia 1041 favoritar teste',
    identity: 'luizcastro/mia-1041-favoritar-teste',
    identityKind: 'branch',
    repoName: 'monest-backend',
    portCount: 0,
    portLabels: [],
    childWorkspaceCount: 0,
    ...overrides
  }
}

function session(overrides: Partial<WorktreeHoverSession> = {}): WorktreeHoverSession {
  return {
    agentType: 'claude',
    dotState: 'done',
    primary: 'MIA-1051 dry-run acordo',
    body: '**resposta** do agente',
    bodyIsMarkdown: true,
    model: 'Fable 5.1',
    timeAgo: '8h',
    hideAgentIcon: false,
    subagents: [],
    ...overrides
  }
}

function render(node: React.JSX.Element): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
  return host
}

const GIANT = 'a'.repeat(400)
const GIANT_WORD = `branch-${'x'.repeat(300)}`

describe('WorktreeHoverCardBody with content that could blow the card open', () => {
  function renderExtreme(): HTMLElement {
    return render(
      <WorktreeHoverCardBody
        facts={facts({
          title: GIANT_WORD,
          identity: GIANT_WORD,
          repoName: GIANT,
          hostLabel: GIANT,
          portCount: 9,
          portLabels: ['3000', '3001', '3002', '4000', '4001', '5173', '5174', '8080', '9229'],
          linearIssue: { identifier: GIANT, title: GIANT, stateName: GIANT },
          review: { provider: 'github', number: 2157012, title: GIANT, state: 'open' },
          note: GIANT
        })}
        session={session({
          primary: GIANT,
          body: GIANT,
          model: GIANT,
          subagents: Array.from({ length: 12 }, (_, index) => ({
            id: `s${index}`,
            name: GIANT,
            dotState: 'working' as const
          }))
        })}
      />
    )
  }

  it('caps the identity lines instead of letting a long name grow the card', () => {
    const host = renderExtreme()
    const title = host.querySelector('[data-worktree-hover-title]')
    const identity = host.querySelector('[data-worktree-hover-identity]')

    expect(title?.className).toContain('line-clamp-2')
    expect(identity?.className).toContain('line-clamp-2')
    // A 300-char word has no space to wrap at, so it must break mid-word.
    expect(identity?.className).toContain('break-all')
  })

  it('clamps the prompt and truncates every single-line value', () => {
    const host = renderExtreme()

    expect(host.querySelector('[data-worktree-hover-prompt]')?.className).toContain('line-clamp-3')
    const valueSpans = [...host.querySelectorAll('[data-worktree-hover-fact] > span:nth-child(2)')]
    expect(valueSpans.length).toBeGreaterThan(4)
    for (const value of valueSpans) {
      expect(value.className).toContain('truncate')
    }
  })

  it('shrinks the model, never the agent name or its state', () => {
    const host = renderExtreme()
    const header = host.querySelector('[data-worktree-hover-session-header]')
    const spans = [...(header?.children ?? [])]
    const model = header?.querySelector('.font-mono')

    expect(model?.className).toContain('truncate')
    expect(model?.className).toContain('min-w-0')
    for (const span of spans) {
      if (span === model) {
        continue
      }
      expect(span.className).not.toContain('truncate')
    }
  })

  it('counts the subagents it does not list', () => {
    const host = renderExtreme()
    const rows = host.querySelectorAll('[data-worktree-hover-subagent]')

    expect(rows).toHaveLength(5)
    expect(host.textContent).toContain('+7 more')
  })
})

describe('WorktreeHoverCardBody', () => {
  it('shows the workspace, its branch and the linked work as chips', () => {
    const host = render(
      <WorktreeHoverCardBody
        facts={facts({
          review: {
            provider: 'github',
            number: 21570,
            title: 'fix(sidebar): hover card',
            state: 'open',
            status: 'success'
          },
          issue: { number: 4821, state: 'open', title: 'Thread do Slack' },
          linearIssue: {
            identifier: 'MIA-1041',
            title: 'Favoritar teste',
            stateName: 'In Progress'
          },
          portCount: 2,
          portLabels: ['3000', '5173'],
          childWorkspaceCount: 3,
          hostLabel: 'hetzner-dev',
          activityAgo: '8h'
        })}
      />
    )
    const text = host.textContent ?? ''

    expect(text).toContain('Mia 1041 favoritar teste')
    expect(text).toContain('luizcastro/mia-1041-favoritar-teste')
    expect(text).toContain('monest-backend')
    expect(text).toContain('#21570')
    expect(text).toContain('#4821')
    expect(text).toContain('MIA-1041')
    expect(text).toContain('hetzner-dev')
    // Ports and children are counts, not lists; the numbers carry the meaning.
    expect(host.querySelector('[aria-label="3000, 5173"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="3 child workspaces"]')).not.toBeNull()
  })

  it('never repeats a title the card already shows', () => {
    const shared = 'Investigação da thread no Slack'
    const host = render(
      <WorktreeHoverCardBody
        facts={facts({
          title: 'Investigate slack thread cases',
          review: { provider: 'github', number: 884, state: 'open', title: shared }
        })}
        session={session({ primary: shared })}
      />
    )

    expect((host.textContent ?? '').match(new RegExp(shared, 'g'))?.length).toBe(1)
  })

  it('renders an assistant reply as markdown and a tool preview as plain text', () => {
    const markdown = render(<WorktreeHoverCardBody facts={facts()} session={session()} />)
    expect(markdown.querySelector('[data-hover-markdown]')).not.toBeNull()

    const plain = render(
      <WorktreeHoverCardBody
        facts={facts()}
        session={session({ body: 'Bash: rg -n "**/*.ts"', bodyIsMarkdown: false })}
      />
    )
    expect(plain.querySelector('[data-hover-markdown]')).toBeNull()
    expect(plain.textContent).toContain('**/*.ts')
  })

  it('lists the subagents a session spawned', () => {
    const host = render(
      <WorktreeHoverCardBody
        facts={facts()}
        session={session({
          subagents: [
            { id: 's1', name: 'pr-reviewer', dotState: 'working' },
            { id: 's2', name: 'test-writer', dotState: 'idle' }
          ]
        })}
      />
    )

    expect(host.textContent).toContain('pr-reviewer')
    expect(host.textContent).toContain('test-writer')
  })

  it('marks unread activity and keeps the live chips slot first', () => {
    const host = render(
      <WorktreeHoverCardBody
        facts={facts({ isUnread: true })}
        workspaceSlot={<span data-live-chip="">In progress</span>}
      />
    )

    expect(host.querySelector('[aria-label="Unread activity"]')).not.toBeNull()
    const chipRow = host.querySelector('[data-live-chip]')?.parentElement
    expect(chipRow?.firstElementChild?.hasAttribute('data-live-chip')).toBe(true)
  })

  it('turns a chip with a destination into a button and leaves the rest plain', () => {
    const openReview = vi.fn()
    const host = render(
      <WorktreeHoverCardBody
        facts={facts({
          review: { provider: 'github', number: 21570, title: 'PR', state: 'open' },
          portCount: 1,
          portLabels: ['3000'],
          links: { openReview }
        })}
      />
    )

    const buttons = [...host.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toContain('#21570')
    expect(host.querySelector('[aria-label="3000"]')?.tagName).toBe('SPAN')
  })

  it('drops the workspace heading when there are no workspace facts', () => {
    const host = render(
      <WorktreeHoverCardBody
        facts={{
          title: '',
          identityKind: 'branch',
          portCount: 0,
          portLabels: [],
          childWorkspaceCount: 0
        }}
        session={session()}
      />
    )

    expect(host.textContent).toContain('MIA-1051 dry-run acordo')
    expect(host.querySelector('[data-worktree-hover-session]')?.className).not.toContain('border-t')
  })
})
