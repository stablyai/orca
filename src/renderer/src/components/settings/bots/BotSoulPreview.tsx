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

type Block =
  | { kind: 'hr' }
  | { kind: 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'ul' | 'ol' | 'quote' | 'p'; lines: string[] }

function parseBlocks(content: string): { key: string; block: Block }[] {
  const blocks: Block[] = []
  const pushLine = (kind: 'ul' | 'ol' | 'quote' | 'p', line: string): void => {
    const last = blocks.at(-1)
    if (last && last.kind === kind) {
      last.lines.push(line)
    } else {
      blocks.push({ kind, lines: [line] })
    }
  }

  let closed = true
  for (const raw of content.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) {
      closed = true
      continue
    }
    if (/^---+$/.test(trimmed)) {
      blocks.push({ kind: 'hr' })
      closed = true
    } else if (trimmed.startsWith('### ')) {
      blocks.push({ kind: 'h3', text: trimmed.slice(4) })
      closed = true
    } else if (trimmed.startsWith('## ')) {
      blocks.push({ kind: 'h2', text: trimmed.slice(3) })
      closed = true
    } else if (trimmed.startsWith('# ')) {
      blocks.push({ kind: 'h1', text: trimmed.slice(2) })
      closed = true
    } else if (/^[-*]\s+/.test(trimmed)) {
      if (closed) {
        blocks.push({ kind: 'ul', lines: [trimmed.replace(/^[-*]\s+/, '')] })
      } else {
        pushLine('ul', trimmed.replace(/^[-*]\s+/, ''))
      }
      closed = false
    } else if (/^\d+\.\s+/.test(trimmed)) {
      if (closed) {
        blocks.push({ kind: 'ol', lines: [trimmed] })
      } else {
        pushLine('ol', trimmed)
      }
      closed = false
    } else if (trimmed.startsWith('> ')) {
      if (closed) {
        blocks.push({ kind: 'quote', lines: [trimmed.slice(2)] })
      } else {
        pushLine('quote', trimmed.slice(2))
      }
      closed = false
    } else {
      if (closed) {
        blocks.push({ kind: 'p', lines: [trimmed] })
      } else {
        pushLine('p', trimmed)
      }
      closed = false
    }
  }

  const counts = new Map<string, number>()
  return blocks.map((block) => {
    const sig =
      block.kind === 'hr'
        ? 'hr'
        : 'text' in block
          ? `${block.kind}:${block.text}`
          : `${block.kind}:${block.lines.join('\n')}`
    const seen = counts.get(sig) ?? 0
    counts.set(sig, seen + 1)
    return { key: `${sig}\u0000${seen}`, block }
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
  const blocks = parseBlocks(content)
  return (
    <div className="space-y-3 text-[13px] leading-[20px] text-foreground/90">
      {blocks.map(({ key, block }) => {
        switch (block.kind) {
          case 'hr':
            return <hr key={key} className="border-border/60" />
          case 'h1':
            return (
              <h1 key={key} className="text-[16px] font-semibold tracking-tight text-foreground">
                {renderInline(block.text)}
              </h1>
            )
          case 'h2':
            return (
              <h2
                key={key}
                className="pt-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase"
              >
                {renderInline(block.text)}
              </h2>
            )
          case 'h3':
            return (
              <h3 key={key} className="pt-0.5 text-[13px] font-semibold text-foreground">
                {renderInline(block.text)}
              </h3>
            )
          case 'ul':
            return (
              <ul key={key} className="space-y-1.5">
                {withKeys(block.lines).map(({ key: lineKey, value: line }) => (
                  <li key={lineKey} className="flex gap-2">
                    <span
                      aria-hidden
                      className="mt-[8px] size-1 shrink-0 rounded-full bg-muted-foreground/70"
                    />
                    <span className="min-w-0 flex-1">{renderInline(line)}</span>
                  </li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key} className="space-y-1.5">
                {withKeys(block.lines).map(({ key: lineKey, value: line }) => {
                  const match = line.match(/^(\d+\.)\s+(.*)$/)
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
          case 'quote':
            return (
              <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">
                {renderInline(block.lines.join(' '))}
              </blockquote>
            )
          case 'p':
            return (
              <p key={key} className="whitespace-pre-wrap text-foreground/90">
                {renderInline(block.lines.join('\n'))}
              </p>
            )
        }
      })}
    </div>
  )
}
