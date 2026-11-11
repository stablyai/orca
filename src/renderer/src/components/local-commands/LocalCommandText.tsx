import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'

const TAB_GLYPH = '\\t'
const VISIBLE_TOKEN = 'rounded-sm bg-muted px-0.5 text-muted-foreground'
const SUSPECT_TOKEN = 'rounded-sm bg-destructive/20 text-destructive'

function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * The command exactly as it will run, with nothing able to hide: tabs show as \t, trailing spaces
 * as ·, and letters outside printable ASCII are tinted and named (lookalikes). Control characters
 * never get here; requests holding them are refused.
 */
export function LocalCommandText({ text }: { text: string }): React.JSX.Element {
  const t = useTranslate()
  const parts: React.ReactNode[] = []
  let key = 0
  let plain = ''
  const flush = (): void => {
    if (plain) {
      parts.push(plain)
      plain = ''
    }
  }
  const lines = text.split('\n')
  lines.forEach((line, lineIndex) => {
    const trailing = line.length - line.trimEnd().length
    const body = line.slice(0, line.length - trailing)
    for (const char of body) {
      if (char === '\t') {
        flush()
        parts.push(
          <span key={key++} className={VISIBLE_TOKEN} title={t('localCommands.text.tab', 'Tab')}>
            {TAB_GLYPH}
          </span>
        )
      } else if (/[\x20-\x7e]/.test(char)) {
        plain += char
      } else {
        flush()
        parts.push(
          <mark key={key++} title={codePoint(char)} className={SUSPECT_TOKEN}>
            {char}
          </mark>
        )
      }
    }
    if (trailing > 0) {
      flush()
      parts.push(
        <span
          key={key++}
          className={VISIBLE_TOKEN}
          title={t('localCommands.text.trailingSpace', 'Trailing whitespace')}
        >
          {line.slice(body.length).replace(/ /g, '·').replace(/\t/g, TAB_GLYPH)}
        </span>
      )
    }
    if (lineIndex < lines.length - 1) {
      plain += '\n'
    }
  })
  flush()
  return <>{parts}</>
}
