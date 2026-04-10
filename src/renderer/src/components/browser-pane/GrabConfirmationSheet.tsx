import { Copy, Image, MessageSquarePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { BrowserGrabPayload } from '../../../../shared/browser-grab-types'

// ---------------------------------------------------------------------------
// Grab payload → human-readable prompt context
// ---------------------------------------------------------------------------

export function formatGrabPayloadAsText(payload: BrowserGrabPayload): string {
  const lines: string[] = []

  lines.push(`Attached browser context from ${payload.page.sanitizedUrl}`)
  lines.push('')

  // Selected element summary
  lines.push('Selected element:')
  lines.push(payload.target.tagName)
  if (payload.target.accessibility.accessibleName) {
    lines.push(`Accessible name: "${payload.target.accessibility.accessibleName}"`)
  }
  if (payload.target.accessibility.role) {
    lines.push(`Role: ${payload.target.accessibility.role}`)
  }
  lines.push(`Selector: ${payload.target.selector}`)
  const { rectViewport } = payload.target
  lines.push(`Dimensions: ${Math.round(rectViewport.width)}x${Math.round(rectViewport.height)}`)
  lines.push('')

  // Text snippet
  if (payload.target.textSnippet) {
    lines.push('Text content:')
    lines.push(payload.target.textSnippet)
    lines.push('')
  }

  // Nearby context
  if (payload.nearbyText.length > 0) {
    lines.push('Nearby context:')
    for (const text of payload.nearbyText) {
      lines.push(`- ${text}`)
    }
    lines.push('')
  }

  // Computed styles
  const styles = payload.target.computedStyles
  const styleLines: string[] = []
  if (styles.display && styles.display !== 'inline') {
    styleLines.push(`display: ${styles.display}`)
  }
  if (styles.position && styles.position !== 'static') {
    styleLines.push(`position: ${styles.position}`)
  }
  if (styles.fontSize) {
    styleLines.push(`font-size: ${styles.fontSize}`)
  }
  if (styles.color) {
    styleLines.push(`color: ${styles.color}`)
  }
  if (styles.backgroundColor && styles.backgroundColor !== 'rgba(0, 0, 0, 0)') {
    styleLines.push(`background: ${styles.backgroundColor}`)
  }
  if (styleLines.length > 0) {
    lines.push('Computed styles:')
    for (const sl of styleLines) {
      lines.push(`  ${sl}`)
    }
    lines.push('')
  }

  // HTML snippet
  if (payload.target.htmlSnippet) {
    lines.push('HTML:')
    lines.push(payload.target.htmlSnippet)
    lines.push('')
  }

  // Ancestor path
  if (payload.ancestorPath.length > 0) {
    lines.push(`Ancestor path: ${payload.ancestorPath.join(' > ')}`)
  }

  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// Security: all page-derived strings are rendered as escaped plain text.
// No innerHTML, no markdown rendering, no auto-linking.
// ---------------------------------------------------------------------------

function EscapedText({ text, className }: { text: string; className?: string }): React.JSX.Element {
  return <span className={className}>{text}</span>
}

// ---------------------------------------------------------------------------
// Confirmation Sheet Component
// ---------------------------------------------------------------------------

export default function GrabConfirmationSheet({
  payload,
  onCopy,
  onCopyScreenshot,
  onAttach,
  onCancel
}: {
  payload: BrowserGrabPayload
  onCopy: () => void
  onCopyScreenshot: (() => void) | null
  onAttach: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { target, page, nearbyText } = payload

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background/98 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="rounded-md bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-400">
            Grab
          </div>
          <span className="text-sm text-muted-foreground">
            Review before attaching. Captured page context may include visible site content.
          </span>
        </div>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onCancel}>
          <X className="size-4" />
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {/* Screenshot preview — only render if dataUrl is a valid PNG data URI.
              Why: the design doc requires screenshots be image/png only. Validating
              the prefix prevents a crafted payload from injecting non-image URIs. */}
          {payload.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (
            <div className="overflow-hidden rounded-lg border border-border/60">
              <img
                src={payload.screenshot.dataUrl}
                alt="Selected element screenshot"
                className="max-h-48 w-full object-contain bg-black/5"
              />
            </div>
          ) : null}

          {/* Element summary */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Selected Element
            </h3>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
              <div className="flex items-baseline gap-2">
                <span className="font-mono font-semibold text-foreground">
                  <EscapedText text={`<${target.tagName}>`} />
                </span>
                {target.accessibility.role ? (
                  <span className="text-xs text-muted-foreground">
                    role=
                    <EscapedText text={target.accessibility.role} />
                  </span>
                ) : null}
              </div>
              {target.accessibility.accessibleName ? (
                <div className="mt-1 text-muted-foreground">
                  &quot;
                  <EscapedText text={target.accessibility.accessibleName} />
                  &quot;
                </div>
              ) : null}
              <div className="mt-1 font-mono text-xs text-muted-foreground/70">
                <EscapedText text={target.selector} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground/60">
                {Math.round(target.rectViewport.width)}x{Math.round(target.rectViewport.height)}
              </div>
            </div>
          </div>

          {/* Page info */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Page
            </h3>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
              <div className="font-medium text-foreground">
                <EscapedText text={page.title || 'Untitled'} />
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground/70">
                <EscapedText text={page.sanitizedUrl} />
              </div>
            </div>
          </div>

          {/* HTML snippet */}
          {target.htmlSnippet ? (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                HTML
              </h3>
              <pre className="max-h-32 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-3 font-mono text-xs text-foreground/80">
                <EscapedText text={target.htmlSnippet} />
              </pre>
            </div>
          ) : null}

          {/* Nearby text */}
          {nearbyText.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Nearby Context
              </h3>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <ul className="list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
                  {nearbyText.map((text, i) => (
                    <li key={i}>
                      <EscapedText text={text} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t border-border/70 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onCopy}>
          <Copy className="size-3.5" />
          Copy
        </Button>
        {onCopyScreenshot ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onCopyScreenshot}>
            <Image className="size-3.5" />
            Copy Screenshot
          </Button>
        ) : null}
        <Button size="sm" className="gap-1.5" onClick={onAttach}>
          <MessageSquarePlus className="size-3.5" />
          Attach to AI
        </Button>
      </div>
    </div>
  )
}
