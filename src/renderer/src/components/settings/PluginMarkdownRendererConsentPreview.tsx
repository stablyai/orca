import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'

export function PluginMarkdownRendererConsentPreview({
  renderers
}: {
  renderers: NonNullable<PluginHostListEntry['markdownRenderers']>
}): React.JSX.Element | null {
  if (renderers.length === 0) {
    return null
  }
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">
        {translate('plugins.markdownRenderers.heading', 'Markdown renderers')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'plugins.markdownRenderers.disclosure',
          'Matching code blocks send their source text and document context to this plugin’s background worker.'
        )}
      </p>
      <ul className="space-y-1 text-xs">
        {renderers.map((renderer) => (
          <li key={renderer.language}>
            <code>{renderer.language}</code>
            {' → '}
            <code>{renderer.commandId}</code>
          </li>
        ))}
      </ul>
    </section>
  )
}
