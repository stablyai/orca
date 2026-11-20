import React from 'react'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'

/** For a How to ask `translate`: escapes the values, since a bot's name may hold "<". */
export const HOW_TO_ASK_ESCAPED = { interpolation: { escapeValue: true } }

/** A translated How to ask sentence, with the text to type (its <code> part) set as code. */
export function BotHowToAsk({ text }: { text: string }): React.JSX.Element {
  return (
    <Trans
      i18n={i18n}
      defaults={text}
      shouldUnescape
      components={{
        code: (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs whitespace-nowrap text-foreground" />
        )
      }}
    />
  )
}
