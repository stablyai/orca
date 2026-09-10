import { translate } from '@/i18n/i18n'
import type { OdooTicket } from '../../../../shared/odoo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { WorktreeCardOdooTicketDisplay } from './worktree-card-meta-types'

/**
 * The card's Odoo badge. Unlike Jira, the linked ticket is not carried on the
 * worktree itself — only its id is — so a loaded ticket is layered over an
 * id-only placeholder rather than the badge disappearing until the read lands.
 */
export function getWorktreeCardOdooTicketDisplay(
  worktree: Pick<Worktree, 'linkedOdooTicket'>,
  ticket: OdooTicket | null
): WorktreeCardOdooTicketDisplay | null {
  if (!worktree.linkedOdooTicket) {
    return null
  }
  if (!ticket) {
    return {
      ref: `#${worktree.linkedOdooTicket}`,
      title: translate(
        'auto.components.sidebar.WorktreeCard.odooTicketLoading',
        'Loading Odoo ticket...'
      )
    }
  }
  return {
    ref: ticket.ref,
    title: ticket.title,
    url: ticket.url,
    ...(ticket.stage?.name ? { stageName: ticket.stage.name } : {}),
    ...(ticket.tags.length > 0 ? { labels: ticket.tags.map((tag) => tag.name) } : {})
  }
}

export function getConfiguredWorktreeCardOdooTicketDisplay(
  worktree: Pick<Worktree, 'linkedOdooTicket'>,
  ticket: OdooTicket | null,
  properties: readonly WorktreeCardProperty[]
): WorktreeCardOdooTicketDisplay | null {
  return properties.includes('odoo-ticket')
    ? getWorktreeCardOdooTicketDisplay(worktree, ticket)
    : null
}
