import DOMPurify from 'dompurify'
import { cn } from '@/lib/utils'
import { IpynbMarkdownCell } from './IpynbCellEditor'
import { IpynbHtmlOutput } from './IpynbHtmlOutput'
import type { IpynbCell, IpynbOutputItem } from './ipynb-parse'

const MAX_ALT_LEN = 140

function valueToText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '')).join('')
  }
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined || value === null) {
    return ''
  }
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

const SVG_VISUAL_CONTENT =
  'circle, ellipse, foreignObject, image, line, path, polygon, polyline, rect, text, use'

function sanitizeSvgImage(value: string): string | null {
  const sanitized = DOMPurify.sanitize(value, {
    USE_PROFILES: { svg: true, svgFilters: true }
  })
  const parsed = new DOMParser().parseFromString(sanitized, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || !root.querySelector(SVG_VISUAL_CONTENT)) {
    return null
  }
  return new XMLSerializer().serializeToString(root)
}

// Strict shape check so corrupt payloads fall back to text instead of a broken <img>.
const STRICT_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function isDecodableBase64(value: string): boolean {
  if (!STRICT_BASE64_PATTERN.test(value)) {
    return false
  }
  try {
    atob(value)
  } catch {
    return false
  }
  return true
}

function dataUriForImage(item: IpynbOutputItem): string | null {
  const value = valueToText(item.value).replace(/\s/g, '')
  if (!value) {
    return null
  }
  if (item.mime === 'image/svg+xml') {
    const sanitized = sanitizeSvgImage(valueToText(item.value))
    return sanitized ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}` : null
  }
  if (!isDecodableBase64(value)) {
    return null
  }
  return `data:${item.mime};base64,${value}`
}

function PreformattedOutput({
  text,
  error = false
}: {
  text: string
  error?: boolean
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        'max-h-[420px] overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-5 scrollbar-editor',
        error ? 'text-destructive' : 'text-foreground'
      )}
    >
      {text}
    </pre>
  )
}

function OutputItem({
  item,
  imageAlt
}: {
  item: IpynbOutputItem
  imageAlt?: string
}): React.JSX.Element | null {
  if (item.mime === 'text/html') {
    return <IpynbHtmlOutput value={valueToText(item.value)} />
  }

  if (item.mime.startsWith('image/')) {
    const uri = dataUriForImage(item)
    if (!uri) {
      return null
    }
    // Keep long text/plain out of layout; full text stays in title.
    const fullAlt = imageAlt?.trim() ?? ''
    const alt =
      fullAlt.length > MAX_ALT_LEN ? `${fullAlt.slice(0, MAX_ALT_LEN - 1)}\u2026` : fullAlt
    return (
      <div className="flex max-w-full overflow-auto p-3 scrollbar-editor">
        <img
          src={uri}
          alt={alt}
          title={fullAlt.length > MAX_ALT_LEN ? fullAlt : undefined}
          className="max-h-[520px] max-w-full object-contain"
        />
      </div>
    )
  }

  if (item.mime === 'application/json' || item.mime.endsWith('+json')) {
    const text =
      typeof item.value === 'string' ? item.value : JSON.stringify(item.value ?? null, null, 2)
    return <PreformattedOutput text={text} />
  }
  if (item.mime === 'text/markdown') {
    return <IpynbMarkdownCell source={valueToText(item.value)} />
  }
  if (item.mime.startsWith('text/') || item.mime === 'application/javascript') {
    return <PreformattedOutput text={valueToText(item.value)} />
  }
  return null
}

function isRenderableItem(item: IpynbOutputItem): boolean {
  if (item.mime.startsWith('image/')) {
    return dataUriForImage(item) !== null
  }
  if (
    item.mime === 'text/html' ||
    item.mime === 'text/markdown' ||
    item.mime.startsWith('text/') ||
    item.mime === 'application/javascript'
  ) {
    return valueToText(item.value).trim().length > 0
  }
  return item.mime === 'application/json' || item.mime.endsWith('+json')
}

export function IpynbCellOutputs({ cell }: { cell: IpynbCell }): React.JSX.Element | null {
  if (cell.outputs.length === 0) {
    return null
  }
  return (
    <div className="border-t border-border/50 bg-background">
      {cell.outputs.map((output, index) => {
        if (output.kind === 'stream') {
          return <PreformattedOutput key={index} text={output.text} />
        }
        if (output.kind === 'error') {
          return (
            <div key={index} className="border-l-2 border-destructive">
              <PreformattedOutput
                error
                text={[output.name, output.message, output.traceback].filter(Boolean).join('\n')}
              />
            </div>
          )
        }
        const item = output.items.find(isRenderableItem)
        const imageAlt = valueToText(
          output.items.find((candidate) => candidate.mime === 'text/plain')?.value
        )
        return item ? (
          <div key={index} className="border-b border-border/40 last:border-b-0">
            <OutputItem item={item} imageAlt={imageAlt} />
          </div>
        ) : null
      })}
    </div>
  )
}
