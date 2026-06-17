import { Check, Clipboard, Eye, FileText, Loader2, Trash2, UploadCloud, X } from 'lucide-react'
import type {
  DiagnosticsBundlePayload,
  DiagnosticsStatusPayload
} from '../../../../preload/api-types'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

export function PrivacyDiagnosticBundleControls({
  status,
  bundle,
  previewOpened,
  ticketId,
  collecting,
  openingPreview,
  uploading,
  discarding,
  copyingTicket,
  deletingTicket,
  onCollect,
  onOpenPreview,
  onUpload,
  onDiscard,
  onCopyTicket,
  onDeleteUploadedBundle,
  onDismissTicket
}: {
  readonly status: DiagnosticsStatusPayload | null
  readonly bundle: DiagnosticsBundlePayload | null
  readonly previewOpened: boolean
  readonly ticketId: string | null
  readonly collecting: boolean
  readonly openingPreview: boolean
  readonly uploading: boolean
  readonly discarding: boolean
  readonly copyingTicket: boolean
  readonly deletingTicket: boolean
  readonly onCollect: () => Promise<void>
  readonly onOpenPreview: () => Promise<void>
  readonly onUpload: () => Promise<void>
  readonly onDiscard: () => Promise<void>
  readonly onCopyTicket: () => Promise<void>
  readonly onDeleteUploadedBundle: () => Promise<void>
  readonly onDismissTicket: () => void
}): React.JSX.Element {
  if (ticketId) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={copyingTicket}
          onClick={() => void onCopyTicket()}
        >
          <ActionIcon busy={copyingTicket} icon={<Clipboard className="size-3.5" />} />
          {translate(
            'auto.components.settings.PrivacyDiagnosticBundleControls.2801d4ce22',
            'Copy reference ID'
          )}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={deletingTicket}
          onClick={() => void onDeleteUploadedBundle()}
        >
          <ActionIcon busy={deletingTicket} icon={<Trash2 className="size-3.5" />} />
          {translate(
            'auto.components.settings.PrivacyDiagnosticBundleControls.7f14a1733c',
            'Delete sent file'
          )}
        </Button>
        <Button variant="ghost" size="sm" disabled={deletingTicket} onClick={onDismissTicket}>
          <Check className="size-3.5" />
          {translate('auto.components.settings.PrivacyDiagnosticBundleControls.2ae9a6b63e', 'Done')}
        </Button>
      </>
    )
  }

  if (bundle) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={openingPreview}
          onClick={() => void onOpenPreview()}
        >
          <ActionIcon busy={openingPreview} icon={<Eye className="size-3.5" />} />
          {translate(
            'auto.components.settings.PrivacyDiagnosticBundleControls.798b6f0be5',
            'Open review file'
          )}
        </Button>
        <Button
          size="sm"
          title={
            previewOpened
              ? undefined
              : translate(
                  'auto.components.settings.PrivacyDiagnosticBundleControls.d8be621237',
                  'Open the review file first.'
                )
          }
          disabled={!previewOpened || uploading}
          onClick={() => void onUpload()}
        >
          <ActionIcon busy={uploading} icon={<UploadCloud className="size-3.5" />} />
          {translate(
            'auto.components.settings.PrivacyDiagnosticBundleControls.aca2c8a367',
            'Send to support'
          )}
        </Button>
        <Button variant="ghost" size="sm" disabled={discarding} onClick={() => void onDiscard()}>
          <ActionIcon busy={discarding} icon={<X className="size-3.5" />} />
          {translate(
            'auto.components.settings.PrivacyDiagnosticBundleControls.a5acaffdb6',
            'Discard'
          )}
        </Button>
      </>
    )
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!status?.bundleEnabled || collecting}
      onClick={() => void onCollect()}
    >
      <ActionIcon busy={collecting} icon={<FileText className="size-3.5" />} />
      {translate(
        'auto.components.settings.PrivacyDiagnosticBundleControls.dc8404a930',
        'Create diagnostic file'
      )}
    </Button>
  )
}

export function getDiagnosticBundleDescription({
  bundle,
  previewOpened,
  ticketId
}: {
  readonly bundle: DiagnosticsBundlePayload | null
  readonly previewOpened: boolean
  readonly ticketId: string | null
}): string {
  if (ticketId) {
    return translate(
      'auto.components.settings.PrivacyDiagnosticBundleControls.61676df223',
      'Diagnostics sent. Share this reference ID with support: {{value0}}.',
      { value0: ticketId }
    )
  }
  if (bundle) {
    const size = formatBytes(bundle.bytes)
    if (previewOpened) {
      return translate(
        'auto.components.settings.PrivacyDiagnosticBundleControls.fd7b3891af',
        'You opened the review file ({{value0}}). Send that file to support, or discard it.',
        { value0: size }
      )
    }
    return translate(
      'auto.components.settings.PrivacyDiagnosticBundleControls.62340d4439',
      'Your review file is ready ({{value0}}). Open it to see what would be sent, then choose whether to send it to support.',
      { value0: size }
    )
  }
  return translate(
    'auto.components.settings.PrivacyDiagnosticBundleControls.19ec5e29b3',
    'Collects recent app activity and errors into a redacted file you can review before sending. Nothing is uploaded until you choose to send it.'
  )
}

function ActionIcon({ busy, icon }: { readonly busy: boolean; readonly icon: React.ReactNode }) {
  return busy ? <Loader2 className="size-3.5 animate-spin" /> : icon
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
