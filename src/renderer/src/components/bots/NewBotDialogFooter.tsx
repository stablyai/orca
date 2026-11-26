// @protected-copy scope=file
// New bot's footer: Template, share-back and Create.
import React from 'react'
import { LayoutTemplate } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { BotCreateButton } from './BotCreateButton'
import type { NewBotShareSource } from './sharing/new-bot-from-share'
import { NewBotShareBack } from './sharing/NewBotFromShareParts'

export function NewBotDialogFooter({
  onTemplate,
  shareSource,
  creating,
  hostBusy
}: {
  /** Offered only before anything is typed, since it closes the dialog. */
  onTemplate?: () => void
  shareSource?: NewBotShareSource
  creating: boolean
  hostBusy: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DialogFooter className="mt-0 shrink-0">
      {onTemplate ? (
        <Button type="button" variant="ghost" size="sm" onClick={onTemplate}>
          <LayoutTemplate aria-hidden />
          {t('bots.new.fromTemplate', 'Template')}
        </Button>
      ) : null}
      {shareSource ? <NewBotShareBack source={shareSource} disabled={creating} /> : null}
      <BotCreateButton type="submit" busy={creating} disabled={creating || hostBusy}>
        {t('bots.new.create', 'Create')}
      </BotCreateButton>
    </DialogFooter>
  )
}
