import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  TerminalTabAttentionBadgeGlyph,
  terminalTabAttentionBadgeLabel
} from './terminal-tab-attention-badge-glyph'
import type { TerminalTabAttentionBadge } from './terminal-tab-activity-status'

function markup(badge: TerminalTabAttentionBadge): string {
  return renderToStaticMarkup(<TerminalTabAttentionBadgeGlyph badge={badge} />)
}

/**
 * Cmd+J's own tests assert the row's sr-only label and never the glyph, so without
 * this the bell could turn into a dot and nothing would say so.
 */
describe('TerminalTabAttentionBadgeGlyph', () => {
  it('renders unread as the amber bell, never an agent dot', () => {
    const html = markup('unread')

    expect(html).toContain('text-amber-500')
    expect(html).toContain('<svg')
    expect(html).not.toContain('data-agent-spinner')
    expect(html).not.toContain('lucide-circle-check')
    // The tab bar's convention: amber is unread, orange is an agent asking.
    expect(html).not.toContain('text-agent-question')
  })

  it('carries no tooltip of its own — both call sites are pointer-events-none', () => {
    expect(markup('unread')).not.toContain('data-slot="tooltip-trigger"')
    expect(markup('done')).not.toContain('data-slot="tooltip-trigger"')
  })

  it.each([
    ['working', 'data-agent-spinner'],
    ['permission', 'text-agent-question'],
    ['done', 'lucide-circle-check']
  ] satisfies [TerminalTabAttentionBadge, string][])(
    'renders %s with AgentStateDot, not the bell',
    (badge, marker) => {
      const html = markup(badge)

      expect(html).toContain(marker)
      expect(html).not.toContain('text-amber-500')
    }
  )

  it('labels unread with the tab bar key so it is not English-only', () => {
    expect(terminalTabAttentionBadgeLabel('unread')).toBe('Unread agent completion')
    expect(terminalTabAttentionBadgeLabel('permission')).toBe('Needs permission')
  })
})
