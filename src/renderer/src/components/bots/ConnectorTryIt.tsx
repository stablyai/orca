import React from 'react'
import { CopyTextButton } from '@/components/clipboard/CopyTextButton'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

/** A setup's Done screen: what to type to ask the bot, each ready to copy, and where it works. */
export function ConnectorTryIt({
  heading,
  ways,
  note
}: {
  heading: string
  /** `shown` may end in "…"; `copy` is what lands on the clipboard, none where pasting can't ask. */
  ways: readonly { key: string; lead?: string; shown: string; copy?: string }[]
  note?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="space-y-2 rounded-lg border border-border bg-background p-3">
      <h3 className="text-xs font-medium">{heading}</h3>
      {ways.map((way) => (
        <div key={way.key} className="space-y-1">
          {way.lead ? <p className="text-xs text-muted-foreground">{way.lead}</p> : null}
          <div
            className={cn(
              'flex items-center gap-2 rounded-md bg-muted pl-2.5',
              way.copy ? 'py-1 pr-1' : 'py-1.5 pr-2.5'
            )}
          >
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{way.shown}</code>
            {way.copy ? (
              <CopyTextButton
                text={way.copy}
                label={t('bots.setup.copyHowToAsk', 'Copy {{text}}', { text: way.copy })}
              />
            ) : null}
          </div>
        </div>
      ))}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </section>
  )
}
