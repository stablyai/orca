import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TerminalTabLeadingIcon } from './TerminalTabLeadingIcon'
import type { TerminalTabActivityStatus } from './terminal-tab-activity-status'

/** Render one activity status through the production leading-icon component. */
function renderStatus(status: TerminalTabActivityStatus): string {
  return renderToStaticMarkup(
    <TerminalTabLeadingIcon
      agent="codex"
      activityStatus={status}
      shell={undefined}
      showUnreadActivity={false}
      isActive={false}
    />
  )
}

describe('TerminalTabLeadingIcon', () => {
  it('shows a working spinner beside the provider icon', () => {
    const markup = renderStatus('working')

    expect(markup).toContain('data-testid="tab-agent-activity-indicator"')
    expect(markup).toContain('data-agent-activity-status="working"')
    expect(markup).toContain('aria-label="Working"')
    expect(markup).toContain('data-agent-spinner')
    expect(markup).toContain('data-agent-icon="codex"')
  })

  it('shows completion as an emerald check', () => {
    const markup = renderStatus('done')

    expect(markup).toContain('data-agent-activity-status="done"')
    expect(markup).toContain('lucide-circle-check')
    expect(markup).toContain('text-emerald-500')
    expect(markup).toContain('data-agent-icon="codex"')
  })

  it('shows a needs-input (permission) state as an amber question glyph', () => {
    const markup = renderStatus('permission')

    expect(markup).toContain('data-agent-activity-status="permission"')
    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-amber-500')
    expect(markup).not.toContain('bg-red-500')
  })

  it('shows no activity glyph for an active shell — just the identity icon', () => {
    const markup = renderStatus('active')

    expect(markup).not.toContain('data-testid="tab-agent-activity-indicator"')
    expect(markup).toContain('data-agent-icon="codex"')
  })

  it('falls back to the shell icon when a plain tab is inactive', () => {
    const markup = renderToStaticMarkup(
      <TerminalTabLeadingIcon
        agent={null}
        activityStatus="inactive"
        shell={undefined}
        showUnreadActivity={false}
        isActive={false}
      />
    )

    expect(markup).toContain('data-shell-icon="generic"')
    expect(markup).not.toContain('data-testid="tab-agent-activity-indicator"')
  })

  it('renders a neutral process glyph with the raw name for an unknown-live agent', () => {
    const markup = renderToStaticMarkup(
      <TerminalTabLeadingIcon
        agent={null}
        unknownLiveProcess="my-fork"
        activityStatus="working"
        shell={undefined}
        showUnreadActivity={false}
        isActive={false}
      />
    )

    // Neutral glyph beside the working dot, labeled by the raw process name —
    // never a provider logo, never the colored shell tile.
    expect(markup).toContain('data-unknown-live-process="my-fork"')
    expect(markup).toContain('title="my-fork"')
    expect(markup).toContain('lucide-terminal')
    expect(markup).not.toContain('data-agent-icon')
    expect(markup).not.toContain('data-shell-icon')
  })

  it('prefers a recognized provider glyph over the unknown-live fallback', () => {
    const markup = renderToStaticMarkup(
      <TerminalTabLeadingIcon
        agent="codex"
        unknownLiveProcess="my-fork"
        activityStatus="active"
        shell={undefined}
        showUnreadActivity={false}
        isActive={false}
      />
    )

    expect(markup).toContain('data-agent-icon="codex"')
    expect(markup).not.toContain('data-unknown-live-process')
  })

  it('keeps the unread bell in the icon slot after an unvisited completion', () => {
    const markup = renderToStaticMarkup(
      <TerminalTabLeadingIcon
        agent="codex"
        activityStatus="done"
        shell={undefined}
        showUnreadActivity={true}
        isActive={false}
      />
    )

    expect(markup).toContain('data-testid="tab-activity-bell"')
    expect(markup).toContain('aria-label="Unread agent completion"')
    expect(markup).toContain('data-agent-icon="codex"')
    expect(markup).not.toContain('data-testid="tab-agent-activity-indicator"')
  })
})
