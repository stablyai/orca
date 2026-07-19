import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalTabLeadingIcon } from './TerminalTabLeadingIcon'
import type { TerminalTabActivityStatus } from './terminal-tab-activity-status'

/** Render one activity status through the production leading-icon component. */
function renderStatus(status: TerminalTabActivityStatus): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TerminalTabLeadingIcon
        agent="opencode"
        activityStatus={status}
        unreadKind={null}
        shell={undefined}
        showUnreadActivity={false}
        isActive={false}
      />
    </TooltipProvider>
  )
}

describe('TerminalTabLeadingIcon', () => {
  it('shows a working spinner beside the provider icon', () => {
    const markup = renderStatus('working')

    expect(markup).toContain('data-testid="tab-agent-activity-indicator"')
    expect(markup).toContain('data-agent-activity-status="working"')
    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="OpenCode · Working"')
    expect(markup.match(/aria-label="OpenCode · Working"/g)).toHaveLength(1)
    expect(markup).toContain('[animation:spin_1s_steps(12,end)_infinite]')
    expect(markup).toContain('data-agent-icon="opencode"')
    expect(markup).toContain('w-7')
  })

  it('shows completion as an emerald check', () => {
    const markup = renderStatus('done')

    expect(markup).toContain('data-agent-activity-status="done"')
    expect(markup).toContain('lucide-circle-check')
    expect(markup).toContain('text-status-success')
    expect(markup).toContain('data-agent-icon="opencode"')
  })

  it('shows a needs-input (permission) state as an amber dot', () => {
    const markup = renderStatus('permission')

    expect(markup).toContain('data-agent-activity-status="permission"')
    expect(markup).toContain('bg-status-attention')
    expect(markup).not.toContain('bg-destructive')
  })

  it('shows blocked as a destructive dot with provider identity', () => {
    const markup = renderStatus('blocked')

    expect(markup).toContain('data-agent-activity-status="blocked"')
    expect(markup).toContain('aria-label="OpenCode · Blocked"')
    expect(markup).toContain('bg-destructive')
    expect(markup).not.toContain('bg-status-attention')
  })

  it('shows interrupted as a destructive outcome instead of an unread bell', () => {
    const markup = renderStatus('interrupted')

    expect(markup).toContain('data-agent-activity-status="interrupted"')
    expect(markup).toContain('aria-label="OpenCode · Interrupted"')
    expect(markup).toContain('bg-destructive')
    expect(markup).not.toContain('data-testid="tab-activity-bell"')
  })

  it('uses the winning sibling provider instead of the focused pane provider', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TerminalTabLeadingIcon
          agent="codex"
          activityAgent="opencode"
          activityStatus="blocked"
          unreadKind={null}
          shell={undefined}
          showUnreadActivity={false}
          isActive={false}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('aria-label="OpenCode · Blocked"')
    expect(markup).toContain('data-agent-icon="opencode"')
    expect(markup).not.toContain('Codex · Blocked')
  })

  it('uses provider-neutral state copy when winning panes are ambiguous', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TerminalTabLeadingIcon
          agent="codex"
          activityAgent={null}
          activityStatus="blocked"
          unreadKind={null}
          shell={undefined}
          showUnreadActivity={false}
          isActive={false}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('aria-label="Blocked"')
    expect(markup).not.toContain('Codex · Blocked')
    expect(markup).not.toContain('data-agent-icon=')
    expect(markup).toContain('w-7')
  })

  it('shows no activity glyph for an active shell — just the identity icon', () => {
    const markup = renderStatus('active')

    expect(markup).not.toContain('data-testid="tab-agent-activity-indicator"')
    expect(markup).toContain('aria-label="OpenCode"')
    expect(markup).toContain('data-agent-icon="opencode"')
    expect(markup).toContain('data-slot="tooltip-trigger"')
    expect(markup).toContain('w-7')
    expect(markup).not.toContain('opacity-70')
  })

  it('falls back to the shell icon when a plain tab is inactive', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TerminalTabLeadingIcon
          agent={null}
          activityStatus="inactive"
          unreadKind={null}
          shell={undefined}
          showUnreadActivity={false}
          isActive={false}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('data-shell-icon="generic"')
    expect(markup).not.toContain('data-testid="tab-agent-activity-indicator"')
  })

  it('keeps the unread bell in the icon slot after an unvisited completion', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TerminalTabLeadingIcon
          agent="opencode"
          activityStatus="done"
          unreadKind="agent-completion"
          shell={undefined}
          showUnreadActivity={true}
          isActive={false}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('data-testid="tab-activity-bell"')
    expect(markup).toContain('data-unread-kind="agent-completion"')
    expect(markup).toContain('aria-label="OpenCode · Unread agent completion"')
    expect(markup).toContain('role="img"')
    expect(markup).toContain('data-slot="tooltip-trigger"')
    expect(markup).toContain('text-status-attention')
    expect(markup).toContain('data-agent-icon="opencode"')
    expect(markup).not.toContain('data-testid="tab-agent-activity-indicator"')
  })

  it('labels sibling unread completion with its provider instead of the focused provider', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TerminalTabLeadingIcon
          agent="codex"
          unreadAgent="opencode"
          activityStatus="done"
          unreadKind="agent-completion"
          shell={undefined}
          showUnreadActivity
          isActive={false}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('aria-label="OpenCode · Unread agent completion"')
    expect(markup).toContain('data-agent-icon="opencode"')
    expect(markup).not.toContain('Codex · Unread agent completion')
  })

  it('uses provider-neutral unread copy when completion ownership is ambiguous', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TerminalTabLeadingIcon
          agent="codex"
          unreadAgent={null}
          activityStatus="done"
          unreadKind="agent-completion"
          shell={undefined}
          showUnreadActivity
          isActive={false}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('aria-label="Unread agent completion"')
    expect(markup).not.toContain('Codex · Unread agent completion')
    expect(markup).not.toContain('data-agent-icon=')
    expect(markup).toContain('w-7')
  })

  it('does not overclaim a generic unread byte as an agent completion', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TerminalTabLeadingIcon
          agent="opencode"
          activityStatus="done"
          unreadKind="terminal-activity"
          shell={undefined}
          showUnreadActivity
          isActive={false}
        />
      </TooltipProvider>
    )

    expect(markup).toContain('data-unread-kind="terminal-activity"')
    expect(markup).toContain('aria-label="OpenCode · Unread terminal activity"')
    expect(markup).not.toContain('Unread agent completion')
  })
})
