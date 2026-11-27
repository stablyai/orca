import { useId, useMemo } from 'react'
import DOMPurify from 'dompurify'
import { useTranslate } from '@/i18n/use-translate'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { INERT_HTML_FRAME_HEAD } from '@/lib/inert-html-frame-head'

/** A full HTML page from a chat code block, rendered inert: no scripts, opaque origin, no network. */
export function NativeChatHtmlPreview({ code }: { code: string }): React.JSX.Element {
  const t = useTranslate()
  const srcDoc = useMemo(
    () =>
      `${INERT_HTML_FRAME_HEAD}${DOMPurify.sanitize(code, {
        WHOLE_DOCUMENT: true,
        USE_PROFILES: { html: true, svg: true, svgFilters: true }
      })}`,
    [code]
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
  previewAvailable,
  onChange
}: {
  previewing: boolean
  previewAvailable: boolean
  onChange: (previewing: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const unavailableReasonId = useId()
  const describedBy = previewAvailable ? undefined : unavailableReasonId
  return (
    <ToggleGroup
      type="single"
      variant="segmented-pill"
      spacing={0.5}
      value={previewing ? 'preview' : 'code'}
      // Radix clears the value when the pressed item is pressed again; keep one view selected.
      onValueChange={(value) => value && onChange(value === 'preview')}
      aria-label={t('components.native-chat.htmlView', 'HTML view')}
      aria-describedby={describedBy}
    >
      <ToggleGroupItem value="code">
        {t('components.native-chat.htmlViewCode', 'Code')}
      </ToggleGroupItem>
      <ToggleGroupItem value="preview" disabled={!previewAvailable} aria-describedby={describedBy}>
        {t('components.native-chat.htmlViewPreview', 'Preview')}
      </ToggleGroupItem>
      {!previewAvailable ? (
        <span id={unavailableReasonId} className="sr-only">
          {t(
            'components.native-chat.htmlViewPreviewWaiting',
            'Preview is available when this code block finishes.'
          )}
        </span>
      ) : null}
    </ToggleGroup>
  )
}
