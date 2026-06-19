import { Clipboard, ExternalLink, GitBranch, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { GlpiTicket } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

export type GlpiTicketAction = { label: string; icon: LucideIcon; action: () => void }

function buildGlpiBranchName(ticket: GlpiTicket): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
  return `glpi-${ticket.id}${slug ? `-${slug}` : ''}`
}

function buildGlpiPrompt(ticket: GlpiTicket): string {
  return `Resolve GLPI ticket #${ticket.id}: ${ticket.title}\n\n${ticket.url}`
}

async function copyGlpiText(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.GlpiTicketWorkspace.57ccc6879c', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(
      translate('auto.components.GlpiTicketWorkspace.d75ad9a7a4', 'Failed to copy {{value0}}', {
        value0: label.toLowerCase()
      })
    )
  }
}

// The sidebar quick-actions for a GLPI ticket (open, copy URL/ID/branch/prompt).
export function buildGlpiTicketActions(ticket: GlpiTicket): GlpiTicketAction[] {
  return [
    {
      label: translate('auto.components.GlpiTicketWorkspace.7f0167c940', 'Open in GLPI'),
      icon: ExternalLink,
      action: () => window.api.shell.openUrl(ticket.url)
    },
    {
      label: translate('auto.components.GlpiTicketWorkspace.fff0f40146', 'Copy URL'),
      icon: Clipboard,
      action: () => void copyGlpiText(ticket.url, 'URL')
    },
    {
      label: translate('auto.components.GlpiTicketWorkspace.a9a5c99719', 'Copy ID'),
      icon: Clipboard,
      action: () => void copyGlpiText(`#${ticket.id}`, 'ID')
    },
    {
      label: translate(
        'auto.components.GlpiTicketWorkspace.6df09513c6',
        'Copy suggested branch name'
      ),
      icon: GitBranch,
      action: () => void copyGlpiText(buildGlpiBranchName(ticket), 'Branch name')
    },
    {
      label: translate('auto.components.GlpiTicketWorkspace.c9dda8c70a', 'Copy prompt'),
      icon: Clipboard,
      action: () => void copyGlpiText(buildGlpiPrompt(ticket), 'Prompt')
    }
  ]
}
