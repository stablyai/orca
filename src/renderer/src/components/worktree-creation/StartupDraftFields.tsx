import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'

export function StartupDraftFields({
  message,
  text,
  onCopy
}: {
  message: string | undefined
  text: string | undefined
  onCopy?: () => void
}) {
  const id = useId()
  const t = useTranslate()
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {message}
      </label>
      <Textarea id={id} readOnly value={text ?? ''} className={onCopy ? 'max-h-40' : undefined} />
      {onCopy ? (
        <Button variant="outline" size="sm" className="self-start" onClick={onCopy}>
          {t('menu.copy', 'Copy')}
        </Button>
      ) : null}
    </div>
  )
}
