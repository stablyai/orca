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

  it('shows a needs-input (permission) state as an amber dot', () => {
    const markup = renderStatus('permission')

    expect(markup).toContain('data-agent-activity-status="permission"')
    expect(markup).toContain('bg-amber-500')
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
