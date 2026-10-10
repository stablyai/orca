import { lazy, Suspense, useState } from 'react'
import { File, FileText, Image as ImageIcon, Music, ShieldAlert, Video, X } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import MediaViewer from '@/components/editor/MediaViewer'
import { formatBytes } from '@/components/status-bar/workspace-space-format'
import { translate } from '@/i18n/i18n'
import type {
  ChatAddressPreviewEntry,
  ChatAddressPreviewResult
} from '../../../../shared/chat-address-preview'
import { addressPreviewErrorMessage } from './native-chat-address-preview-error'

const PdfViewer = lazy(() => import('@/components/editor/PdfViewer'))
const PreviewMarkdown = lazy(() => import('./NativeChatAddressPreviewMarkdown'))
type ReadyPreview = Extract<ChatAddressPreviewResult, { status: 'ready' }>
type Props = {
  entries: readonly ChatAddressPreviewEntry[]
  onDismiss: (id: string) => void
  onRetry: (id: string) => void
  onAllowPrivateNetwork: (id: string) => void
}

/** Display only: keep credentials and signed query strings out of labels and tooltips. */
function displaySource(source: string): string {
  if (!/^https?:\/\//i.test(source)) {
    return source
  }
  try {
    const url = new URL(source)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return translate('components.native-chat.addressPreview.networkAddress', 'Network address')
  }
}

function PreviewLoading(): React.JSX.Element {
  return (
    <div role="status" className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
      <LoadingSpinner className="size-4 shrink-0" />
      {translate('components.native-chat.addressPreview.loading', 'Loading preview…')}
    </div>
  )
}

function PreviewBody({ result }: { result: ReadyPreview }): React.JSX.Element {
  if (result.kind === 'pdf') {
    return <PdfViewer content={result.content!} filePath={displaySource(result.name)} />
  }
  return (
    <div className="scrollbar-sleek min-h-0 overflow-auto p-4">
      {result.kind === 'markdown' ? (
        <PreviewMarkdown content={result.content!} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">
          <code>{result.content}</code>
        </pre>
      )}
    </div>
  )
}

function ReadyPreviewCard({
  result,
  source,
  onRetry
}: {
  result: ReadyPreview
  source: string
  onRetry: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [mediaFailed, setMediaFailed] = useState(false)
  const label = displaySource(result.name) || source
  const isMedia = result.kind === 'audio' || result.kind === 'video'
  const isImage = result.kind === 'image'
  const canExpand =
    result.kind !== 'file' &&
    !isMedia &&
    (isImage ? Boolean(result.url) : result.content !== undefined)
  const Icon = isImage
    ? ImageIcon
    : result.kind === 'audio'
      ? Music
      : result.kind === 'video'
        ? Video
        : result.kind === 'file'
          ? File
          : FileText
  const details = (
    <>
      <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/20">
        {isImage && result.url && !imageFailed ? (
          <img
            src={result.url}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left text-xs">
        <span className="truncate font-medium text-foreground" title={label}>
          {label}
        </span>
        <span className="truncate text-muted-foreground" title={source}>
          {source}
        </span>
        <span className="truncate text-muted-foreground">
          {result.mimeType}
          {result.size !== undefined ? ` · ${formatBytes(result.size)}` : ''}
        </span>
      </span>
    </>
  )
  return (
    <>
      {canExpand ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={translate(
            'components.native-chat.addressPreview.open',
            'Open preview: {{name}}',
            { name: label }
          )}
          className="flex w-full min-w-0 items-center gap-2 rounded-md p-2 pr-9 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {details}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 p-2 pr-9">{details}</div>
      )}
      {isMedia && result.url && (
        <div
          onErrorCapture={() => setMediaFailed(true)}
          className={`w-full overflow-hidden rounded-b-md [&_audio]:min-w-0 [&_video]:w-full ${result.kind === 'video' ? 'h-48' : 'h-24'}`}
        >
          <MediaViewer
            key={result.url}
            src={result.url}
            mimeType={result.mimeType}
            filePath={label}
            canOpenLocally={false}
          />
        </div>
      )}
      {mediaFailed && (
        <div className="px-2 pb-2">
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            {translate('components.native-chat.addressPreview.retry', 'Retry')}
          </Button>
        </div>
      )}
      {imageFailed && (
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
          <p role="alert" className="text-xs text-muted-foreground">
            {translate(
              'components.native-chat.addressPreview.imageUnavailable',
              'Unable to display this image.'
            )}
          </p>
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            {translate('components.native-chat.addressPreview.retry', 'Retry')}
          </Button>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-[90vw] min-w-0 flex-col sm:max-w-4xl">
          <DialogTitle className="truncate pr-6 text-sm">{label}</DialogTitle>
          <DialogDescription className="truncate" title={source}>
            {source}
          </DialogDescription>
          {open && (
            <div
              className={`flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background ${isImage ? '' : 'h-[65vh]'}`}
            >
              {isImage ? (
                imageFailed ? (
                  <p role="alert" className="p-4 text-sm text-muted-foreground">
                    {translate(
                      'components.native-chat.addressPreview.imageUnavailable',
                      'Unable to display this image.'
                    )}
                  </p>
                ) : (
                  <img
                    src={result.url}
                    alt={label}
                    referrerPolicy="no-referrer"
                    onError={() => setImageFailed(true)}
                    className="max-h-[70vh] max-w-full object-contain"
                  />
                )
              ) : (
                <Suspense fallback={<PreviewLoading />}>
                  <PreviewBody result={result} />
                </Suspense>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export function NativeChatAddressPreviews({
  entries,
  onDismiss,
  onRetry,
  onAllowPrivateNetwork
}: Props): React.JSX.Element | null {
  if (entries.length === 0) {
    return null
  }
  return (
    <ul
      aria-label={translate('components.native-chat.addressPreview.list', 'Address previews')}
      className="scrollbar-sleek flex max-h-[40vh] min-w-0 flex-wrap items-start gap-2 overflow-y-auto pr-1"
    >
      {entries.map(({ id, source: originalSource, result }) => {
        const source = displaySource(originalSource)
        return (
          <li
            key={id}
            className="relative w-72 max-w-full min-w-0 rounded-md border border-border bg-chat-canvas"
          >
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-1 top-1 z-10 text-muted-foreground"
              aria-label={translate(
                'components.native-chat.addressPreview.remove',
                'Remove preview: {{name}}',
                { name: source }
              )}
              title={translate(
                'components.native-chat.addressPreview.removeHint',
                'Remove preview only; keep pasted text'
              )}
              onClick={() => onDismiss(id)}
            >
              <X aria-hidden="true" className="size-3" />
            </Button>
            {result?.status === 'ready' ? (
              <ReadyPreviewCard
                key={JSON.stringify([id, originalSource, result.url, result.kind])}
                result={result}
                source={source}
                onRetry={() => onRetry(id)}
              />
            ) : (
              <div className="flex min-w-0 flex-col gap-2 p-2 pr-9">
                <p className="truncate text-xs text-foreground" title={source}>
                  {source}
                </p>
                {!result ? (
                  <PreviewLoading />
                ) : result.status === 'permission-required' ? (
                  <>
                    <p className="flex items-start gap-2 text-xs text-muted-foreground">
                      <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
                      {translate(
                        'components.native-chat.addressPreview.privateNetworkExplanation',
                        'This address reaches a private network. Allow this preview to connect to that network and read the file?'
                      )}
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-auto min-h-8 self-start whitespace-normal text-left"
                      onClick={() => onAllowPrivateNetwork(id)}
                    >
                      {translate(
                        'components.native-chat.addressPreview.allowPrivateNetwork',
                        'Allow network preview'
                      )}
                    </Button>
                  </>
                ) : (
                  <>
                    <p role="alert" className="text-xs text-muted-foreground">
                      {addressPreviewErrorMessage(result.message)}
                    </p>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="self-start"
                      onClick={() => onRetry(id)}
                    >
                      {translate('components.native-chat.addressPreview.retry', 'Retry')}
                    </Button>
                  </>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
