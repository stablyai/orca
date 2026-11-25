import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { BotAutomationSection } from '../automations/authoring/automation-bot-section-save'

/** Asked only by Back, Escape and the crumb while a section has unsaved changes. */
export function BotAutomationDiscardDialog({
  open,
  section,
  onKeep,
  onDiscard
}: {
  open: boolean
  section: BotAutomationSection
  onKeep: () => void
  onDiscard: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const keepRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onKeep())}>
      <DialogContent
        className="max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          keepRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle size="compact">
            {section === 'when'
              ? t('bots.automationPanel.discardWhen', 'Discard changes to When?')
              : t('bots.automationPanel.discardResults', 'Discard changes to Results?')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t('bots.automationPanel.discardBody', "Your edit hasn't been saved.")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={keepRef} variant="outline" onClick={onKeep}>
            {t('bots.automationPanel.keepEditing', 'Keep editing')}
          </Button>
          <Button variant="destructive" onClick={onDiscard}>
            {t('bots.automationPanel.discard', 'Discard')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
