import { Globe } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { loadWebLinkPreview, readCachedWebLinkPreview } from './native-chat-web-link-preview'
import { useNativeChatHoverPreview } from './use-native-chat-hover-preview'

/** Title, description and image a page declares about itself, fetched by the chat's host. */
export function NativeChatWebPeekBody({
  url,
  runtimeEnvironmentId
}: {
  url: string
  runtimeEnvironmentId: string | null
}): React.JSX.Element {
  const { state } = useNativeChatHoverPreview(
    `${runtimeEnvironmentId ?? 'local'}:${url}`,
    () => readCachedWebLinkPreview(url, runtimeEnvironmentId),
    () => loadWebLinkPreview(url, runtimeEnvironmentId)
  )
  const preview = state.status === 'ready' ? state.value : null
  const host = new URL(url).hostname.replace(/^www\./, '')
  return (
    <div className="flex flex-col gap-1.5">
      {preview?.imageDataUrl ? (
        <div className="-mx-4 -mt-4 mb-1.5 overflow-hidden rounded-t-md border-b border-border">
          <img src={preview.imageDataUrl} alt="" className="aspect-[1.91/1] w-full object-cover" />
        </div>
      ) : null}
      {/* Known from the URL, so the card has a header before the page answers. */}
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {preview?.faviconDataUrl ? (
          <img src={preview.faviconDataUrl} alt="" className="size-3.5 shrink-0 rounded-sm" />
        ) : (
          <Globe className="size-3.5 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 truncate">{preview?.siteName ?? host}</span>
      </div>
      {preview ? (
        <>
          {preview.title ? (
            <div className="line-clamp-2 text-sm font-semibold text-foreground">
              {preview.title}
            </div>
          ) : null}
          {preview.description ? (
            <div className="line-clamp-3 text-xs text-muted-foreground">{preview.description}</div>
          ) : null}
        </>
      ) : state.status === 'loading' ? (
        <div aria-hidden className="flex flex-col gap-1.5 motion-safe:animate-pulse">
          <div className="h-3.5 w-11/12 rounded bg-muted" />
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-3 w-2/3 rounded bg-muted" />
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          {translate('components.native-chat.webPeek.unavailable', 'No preview for this page.')}
        </div>
      )}
    </div>
  )
}
