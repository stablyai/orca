import { useDeferredValue, useMemo } from 'react'
import DOMPurify from 'dompurify'
import { useTranslate } from '@/i18n/use-translate'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { INERT_HTML_FRAME_HEAD } from '@/lib/inert-html-frame-head'

/** A full HTML page from a chat code block, rendered inert: no scripts, opaque origin, no network. */
export function NativeChatHtmlPreview({ code }: { code: string }): React.JSX.Element {
  const t = useTranslate()
  // Why deferred: a block still streaming would re-sanitize and reload the frame on every chunk.
  const page = useDeferredValue(code)
  const srcDoc = useMemo(
    () =>
      `${INERT_HTML_FRAME_HEAD}${DOMPurify.sanitize(page, {
        WHOLE_DOCUMENT: true,
        USE_PROFILES: { html: true, svg: true, svgFilters: true }
      })}`,
    [page]
  )
  return (
    <iframe
      title={t('components.native-chat.htmlPreview', 'HTML preview')}
      // SECURITY: never add allow-same-origin or allow-scripts; agent-written HTML is untrusted.
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="block h-50 w-full border-0 border-t border-chat-code-border bg-white"
      // Why: pages are authored for a white ground; a dark color-scheme would paint the canvas dark.
      style={{ colorScheme: 'light' }}
    />
  )
}

export function NativeChatHtmlViewToggle({
  previewing,
  onChange
}: {
  previewing: boolean
  onChange: (previewing: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ToggleGroup
      type="single"
      variant="segmented-pill"
      spacing={0.5}
      value={previewing ? 'preview' : 'code'}
      // Radix clears the value when the pressed item is pressed again; keep one view selected.
      onValueChange={(value) => value && onChange(value === 'preview')}
      aria-label={t('components.native-chat.htmlView', 'HTML view')}
    >
      <ToggleGroupItem value="code">
        {t('components.native-chat.htmlViewCode', 'Code')}
      </ToggleGroupItem>
      <ToggleGroupItem value="preview">
        {t('components.native-chat.htmlViewPreview', 'Preview')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
