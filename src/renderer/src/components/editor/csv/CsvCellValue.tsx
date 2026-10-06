import type { MouseEvent } from 'react'

export function CsvCellValue({
  value,
  onOpenUrl
}: {
  value: string
  onOpenUrl?: (url: string, event: MouseEvent<HTMLAnchorElement>) => void
}): React.JSX.Element {
  const candidate = value.trim()
  let href: string | undefined
  if (onOpenUrl && /^https?:\/\/\S+$/i.test(candidate)) {
    try {
      href = new URL(candidate).href
    } catch {
      // Malformed URLs stay selectable text.
    }
  }
  return href ? (
    <a
      href={href}
      className="truncate rounded text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        event.preventDefault()
        onOpenUrl?.(href, event)
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault()
          onOpenUrl?.(href, event)
        }
      }}
    >
      {value}
    </a>
  ) : (
    <span className="truncate">{value}</span>
  )
}
