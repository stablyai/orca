import { ChevronDown, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { preventAgentSendTargetOutsideDismiss } from '../delivery/prevent-agent-send-target-outside-dismiss'
import { useAnnotatePalettePopupSide } from './annotate-palette-position-store'

/** Annotate's palette actions: the note count, which opens the notes list, and Send with the agent menu. */
export function BrowserAnnotatePaletteNotes({
  count,
  short,
  onShowNotes,
  notesOpen,
  sendOpen,
  onSendOpenChange,
  sendDisabled,
  sendMenu
}: {
  count: number
  /** Narrow palette: the count without the word, Send as an icon. */
  short: boolean
  onShowNotes: () => void
  /** The notes list is open (the chip toggles it). */
  notesOpen: boolean
  sendOpen: boolean
  onSendOpenChange: (open: boolean) => void
  sendDisabled: boolean
  /** The existing agent-target menu. */
  sendMenu: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const popupSide = useAnnotatePalettePopupSide()
  const countLabel =
    count === 1
      ? t('browser.annotatePalette.noteCountOne', '1 note')
      : t('browser.annotatePalette.noteCount', '{{count}} notes', { count })
  const sendLabel = t(
    'auto.components.browser.pane.BrowserPane.95af781091',
    'Send feedback to an agent'
  )
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0"
        onClick={onShowNotes}
        aria-expanded={notesOpen}
        data-browser-annotate-notes-chip
        // The narrow chip shows a bare number; its name still says what it counts.
        aria-label={countLabel}
        title={t('browser.annotatePalette.showNotes', 'Show notes')}
      >
        {short ? count : countLabel}
      </Button>
      <DropdownMenu modal={false} open={sendOpen} onOpenChange={onSendOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            size={short ? 'icon-xs' : 'xs'}
            className="shrink-0"
            disabled={sendDisabled}
            aria-label={sendLabel}
            title={sendLabel}
          >
            <Send className="size-3.5" />
            {short ? null : t('auto.components.browser.pane.BrowserPane.ac39b9366b', 'Send')}
            {short ? null : <ChevronDown className="size-3.5" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side={popupSide}
          className="min-w-[180px]"
          onInteractOutside={preventAgentSendTargetOutsideDismiss}
          onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
        >
          {sendMenu}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
