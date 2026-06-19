import { getLinkedWorkItemSuggestedName } from '../../../shared/workspace-name'
import type { GlpiTicket } from '../../../shared/types'

// Why: GLPI tickets carry no git-repo identity, so the workspace seed is built
// from the numeric ticket id plus its title — mirroring getJiraIssueWorkspaceSeed
// but keyed on the GLPI `glpi-<id>` identifier instead of a string issue key.
export function getGlpiTicketWorkspaceSeed(ticket: GlpiTicket): string {
  const seed = getLinkedWorkItemSuggestedName({ title: ticket.title })
  return seed || `glpi-${ticket.id}`
}

// Why: GLPI's closed/solved lifecycle reads "done", in-progress states read
// "active", everything else stays neutral — matching getJiraStatusTone tiers.
export function getGlpiStatusTone(status: GlpiTicket['status']): string {
  if (status === 'closed' || status === 'solved') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (status === 'assigned' || status === 'planned' || status === 'pending') {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  }
  return 'border-border/50 bg-muted/40 text-muted-foreground'
}
