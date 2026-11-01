import { createContext, useContext } from 'react'
import type { Components } from 'react-markdown'
import CommentMarkdown, {
  type CommentMarkdownExtension
} from '@/components/sidebar/CommentMarkdown'
import { isPluginDeclarativeImagePath } from '../../../../../shared/plugins/declarative/plugin-declarative-content-props'
import {
  pluginDeclarativeGestureId,
  useGestureTrackRef
} from './plugin-declarative-gesture-geometry'
import {
  isPluginDeclarativeExternalHref,
  PluginDeclarativeHostServicesContext
} from './plugin-declarative-assets'
import { PluginDeclarativeImage } from './PluginDeclarativeImage'

const MarkdownGestureContext = createContext('')

/** Every link opens through the host's checked path, judged by the Markdown block's own settle. */
function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const { openLink } = useContext(PluginDeclarativeHostServicesContext)
  const gestureId = useContext(MarkdownGestureContext)
  if (!isPluginDeclarativeExternalHref(href)) {
    return <span>{children}</span>
  }
  return (
    <button
      type="button"
      role="link"
      title={href}
      className="cursor-pointer text-primary underline underline-offset-2 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={() => openLink?.(href, gestureId)}
    >
      {children}
    </button>
  )
}

/** Only images inside the plugin; any other source shows its alt text. */
function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  return typeof src === 'string' && isPluginDeclarativeImagePath(src) ? (
    <PluginDeclarativeImage src={src} alt={alt ?? ''} size="full" />
  ) : alt ? (
    <span>{alt}</span>
  ) : null
}

const components: Components = { a: MarkdownLink, img: MarkdownImage }
// Stable: a new extension object would remount the rendered blocks.
const PLUGIN_MARKDOWN: CommentMarkdownExtension = {
  remarkPlugins: [],
  sanitizeAttributes: {},
  components
}

/** GitHub-flavoured Markdown through Orca's sanitized renderer, with plugin-safe links and images. */
export function PluginDeclarativeMarkdown({ content }: { content: string }): React.JSX.Element {
  const gestureId = pluginDeclarativeGestureId.markdown(content)
  const trackRef = useGestureTrackRef(gestureId)
  return (
    <MarkdownGestureContext.Provider value={gestureId}>
      <div ref={trackRef} className="min-w-0 text-sm text-foreground">
        <CommentMarkdown
          content={content}
          variant="document"
          extension={PLUGIN_MARKDOWN}
          renderMermaid={false}
          unknownHtmlAsText
        />
      </div>
    </MarkdownGestureContext.Provider>
  )
}
