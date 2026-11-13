import { Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useFileCustomEditors } from '@/store/plugins/file-editors/plugin-custom-editors'
import { sentenceStop } from '../../../../shared/sentence-joining'

function detail(title: string, t: Translate = translate): string {
  return isWebClientLocation()
    ? t(
        'auto.components.editor.PluginEditorNeedsDesktopNotice.browser',
        '{{value0}} runs only in an isolated frame, which browser clients cannot give it.',
        { value0: title }
      )
    : t(
        'auto.components.editor.PluginEditorNeedsDesktopNotice.isolationOff',
        '{{value0}} runs only in an isolated frame, and isolated plugin frames are turned off.',
        { value0: title }
      )
}

/** An isolated-only editor this window cannot run. Inline: a strip above Source; else the
 *  editor's own view, with a way back to Source. */
export function PluginEditorNeedsDesktopNotice({
  title,
  onOpenSource,
  inline = false
}: {
  title: string
  onOpenSource?: () => void
  inline?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const heading = t(
    'auto.components.editor.PluginEditorNeedsDesktopNotice.heading',
    'This editor needs the Orca desktop app'
  )
  if (inline) {
    const headingStop = sentenceStop(heading)
    return (
      <div
        role="status"
        className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="font-medium text-foreground">
          {heading}
          {headingStop}
        </span>
        {headingStop === '。' ? null : ' '}
        {detail(title, t)}
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
      <div
        role="status"
        className="flex max-w-xl items-start gap-3 rounded-md border border-border bg-background p-4"
      >
        <Monitor className="mt-0.5 size-4 flex-shrink-0" />
        <div className="min-w-0">
          <div className="font-medium text-foreground">{heading}</div>
          <div className="mt-1 break-words">{detail(title, t)}</div>
          {onOpenSource ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={onOpenSource}
            >
              {t('auto.components.editor.PluginEditorNeedsDesktopNotice.openSource', 'Open Source')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** The strip above Source when the file opened there because its default editor cannot run. */
export function PluginEditorSourceFallbackNotice({
  fileId,
  filePath
}: {
  fileId: string
  filePath: string
}): React.JSX.Element | null {
  const { customEditors, customEditorChoice } = useFileCustomEditors(fileId, filePath)
  const unavailable = customEditors.find((editor) => editor.frameUnavailable)
  // Why not after a pick: choosing Source is a choice, not a fallback worth explaining.
  if (!unavailable || customEditorChoice !== undefined) {
    return null
  }
  return <PluginEditorNeedsDesktopNotice title={unavailable.title} inline />
}
