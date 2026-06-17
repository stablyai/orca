import { Clipboard, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import type { TrelloCard } from '../../../shared/trello-types'
import type { TrelloCardDetailActionItem } from '@/components/trello-card-detail-sidebar'

export async function copyTrelloCardDetailText(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(`${label} copied`)
  } catch {
    toast.error(`Failed to copy ${label.toLowerCase()}`)
  }
}

export function createTrelloCardDetailActionItems(
  card: TrelloCard,
  renderedContext: string
): TrelloCardDetailActionItem[] {
  return [
    {
      label: 'Copy URL',
      icon: Clipboard,
      action: () => void copyTrelloCardDetailText(card.url, 'URL')
    },
    {
      label: 'Copy short link',
      icon: Clipboard,
      action: () =>
        void copyTrelloCardDetailText(
          card.shortUrl || `https://trello.com/c/${card.shortLink || card.id}`,
          'Short link'
        )
    },
    {
      label: 'Copy prompt',
      icon: Clipboard,
      action: () => void copyTrelloCardDetailText(renderedContext, 'Prompt')
    },
    {
      label: 'Open in Trello',
      icon: ExternalLink,
      action: () => window.api.shell.openUrl(card.url)
    }
  ]
}
