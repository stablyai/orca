// Editorial Markdown block preview for a bot's SOUL.md in Settings.
import type { ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'

function withKeys(items: readonly string[]): { key: string; value: string }[] {
  const counts = new Map<string, number>()
  return items.map((value) => {
    const seen = counts.get(value) ?? 0
    counts.set(value, seen + 1)
    return { key: `${value}\u0000${seen}`, value }
  })
}

function renderInline(text: string): ReactNode {
  const tokens = withKeys(text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g))
  return tokens.map(({ key, value }) => {
    if (value.startsWith('`') && value.endsWith('`') && value.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[11.5px] text-foreground"
        >
          {value.slice(1, -1)}
        </code>
      )
    }
    if (value.startsWith('**') && value.endsWith('**') && value.length > 4) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          {value.slice(2, -2)}
        </strong>
      )
    }
    if (value.startsWith('*') && value.endsWith('*') && value.length > 2) {
      return <em key={key}>{value.slice(1, -1)}</em>
    }
    return <span key={key}>{value}</span>
  })
}

/** Crisp block-level Markdown preview tuned for SOUL.md in narrow and wide Settings hosts. */
export function BotSoulPreview({ content }: { content: string }): React.JSX.Element {
  const t = useTranslate()
  if (!content.trim()) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('settings.bots.soulEmpty', 'No instructions yet. Double-click or select Edit to write.')}
      </p>
    )
  }
  const blocks = withKeys(
    content
      .replace(/\r\n/g, '\n')
      .trim()
      .split(/\n{2,}/)
  )
  return (
    <div className="space-y-3 text-[13px] leading-[20px] text-foreground/90">
      {blocks.map(({ key, value }) => {
        const trimmed = value.trim()
        if (/^---+$/.test(trimmed)) {
          return <hr key={key} className="border-border/60" />
        }
        if (trimmed.startsWith('# ')) {
          return (
            <h1 key={key} className="text-[16px] font-semibold tracking-tight text-foreground">
              {renderInline(trimmed.slice(2))}
            </h1>
          )
        }
        if (trimmed.startsWith('## ')) {
          return (
            <h2
              key={key}
              className="pt-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase"
            >
              {renderInline(trimmed.slice(3))}
            </h2>
          )
        }
        if (trimmed.startsWith('### ')) {
          return (
            <h3 key={key} className="pt-0.5 text-[13px] font-semibold text-foreground">
              {renderInline(trimmed.slice(4))}
            </h3>
          )
        }
        const lines = withKeys(trimmed.split('\n'))
        if (lines.every(({ value: line }) => /^[-*]\s+/.test(line.trim()))) {
          return (
            <ul key={key} className="space-y-1.5">
              {lines.map(({ key: lineKey, value: line }) => (
                <li key={lineKey} className="flex gap-2">
                  <span
                    aria-hidden
                    className="mt-[8px] size-1 shrink-0 rounded-full bg-muted-foreground/70"
                  />
                  <span className="min-w-0 flex-1">
                    {renderInline(line.trim().replace(/^[-*]\s+/, ''))}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
        if (lines.every(({ value: line }) => /^\d+\.\s+/.test(line.trim()))) {
          return (
            <ol key={key} className="space-y-1.5">
              {lines.map(({ key: lineKey, value: line }) => {
                const match = line.trim().match(/^(\d+\.)\s+(.*)$/)
                return (
                  <li key={lineKey} className="flex gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {match?.[1]}
                    </span>
                    <span className="min-w-0 flex-1">{renderInline(match?.[2] ?? line)}</span>
                  </li>
                )
              })}
            </ol>
          )
        }
        if (lines.every(({ value: line }) => line.trim().startsWith('> '))) {
          return (
            <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">
              {renderInline(lines.map(({ value: line }) => line.trim().slice(2)).join(' '))}
            </blockquote>
          )
        }
        return (
          <p key={key} className="whitespace-pre-wrap text-foreground/90">
            {renderInline(trimmed)}
          </p>
        )
      })}
    </div>
  )
}
