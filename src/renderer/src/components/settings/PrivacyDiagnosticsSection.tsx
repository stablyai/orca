import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, FileText, Folder, Globe, Trash2 } from 'lucide-react'
import type {
  DiagnosticsBundlePayload,
  DiagnosticsStatusPayload,
  DiagnosticsUploadPayload
} from '../../../../preload/api-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'

type PreviewState =
  | { stage: 'idle' }
  | { stage: 'collecting' }
  | { stage: 'preview'; bundle: DiagnosticsBundlePayload; editedPayload: string }
  | { stage: 'uploading'; bundle: DiagnosticsBundlePayload; editedPayload: string }
  | { stage: 'sent'; ticketId: string; bundleSubmissionId: string }

export function PrivacyDiagnosticsSection(): React.JSX.Element {
  const [status, setStatus] = useState<DiagnosticsStatusPayload | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ stage: 'idle' })
  const [copied, setCopied] = useState(false)
  const refreshTokenRef = useRef(0)
  const copyTimerRef = useRef<number | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const token = ++refreshTokenRef.current
    try {
      const next = await window.api.diagnostics.getStatus()
      if (token === refreshTokenRef.current) {
        setStatus(next)
      }
    } catch {
      /* swallow — pane shows N/A while the IPC is unavailable */
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const handleOpenFolder = useCallback(async (): Promise<void> => {
    try {
      await window.api.diagnostics.openTraceFolder()
    } catch {
      toast.error('Could not open trace folder')
    }
  }, [])

  const handleClear = useCallback(async (): Promise<void> => {
    try {
      await window.api.diagnostics.clearTraces()
      await refreshStatus()
      toast.success('Local trace files cleared')
    } catch {
      toast.error('Could not clear trace files')
    }
  }, [refreshStatus])

  const handleStartShare = useCallback(async (): Promise<void> => {
    setPreview({ stage: 'collecting' })
    try {
      const bundle = await window.api.diagnostics.collectBundle()
      setPreview({ stage: 'preview', bundle, editedPayload: bundle.payload })
    } catch (err) {
      setPreview({ stage: 'idle' })
      toast.error(`Could not collect bundle: ${(err as Error).message}`)
    }
  }, [])

  const handleConfirmUpload = useCallback(async (): Promise<void> => {
    if (preview.stage !== 'preview') {
      return
    }
    const { bundle, editedPayload } = preview
    setPreview({ stage: 'uploading', bundle, editedPayload })
    try {
      const result: DiagnosticsUploadPayload = await window.api.diagnostics.uploadBundle(
        editedPayload,
        bundle.bundleSubmissionId
      )
      setPreview({
        stage: 'sent',
        ticketId: result.ticketId,
        bundleSubmissionId: bundle.bundleSubmissionId
      })
    } catch (err) {
      setPreview({ stage: 'preview', bundle, editedPayload })
      toast.error(`Could not upload bundle: ${(err as Error).message}`)
    }
  }, [preview])

  const handleCopyTicket = useCallback(async (): Promise<void> => {
    if (preview.stage !== 'sent') {
      return
    }
    try {
      await navigator.clipboard.writeText(preview.ticketId)
      setCopied(true)
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null
        setCopied(false)
      }, 2_000)
    } catch {
      toast.error('Could not copy ticket ID')
    }
  }, [preview])

  return (
    <>
      {status?.disabledReason ? (
        <DiagnosticsDisabledStateNote reason={status.disabledReason} />
      ) : null}
      <Separator />
      <Section
        icon={<Folder className="size-4" />}
        title="Open trace folder"
        description={`Reveals ${status?.traceFilePath || 'the trace folder'} in your file manager.`}
      >
        <Button variant="outline" size="sm" onClick={() => void handleOpenFolder()}>
          Open trace folder
        </Button>
      </Section>
      <Separator />
      <Section
        icon={<Trash2 className="size-4" />}
        title="Clear local traces"
        description="Deletes every rotated trace file on this machine."
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!status?.localFileEnabled}
          onClick={() => void handleClear()}
        >
          Clear local traces
        </Button>
      </Section>
      <Separator />
      <Section
        icon={<FileText className="size-4" />}
        title="Share a diagnostic bundle"
        description="Preview and optionally upload the last 30 minutes of redacted traces."
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!status?.bundleEnabled || preview.stage !== 'idle'}
          onClick={() => void handleStartShare()}
        >
          {preview.stage === 'collecting' ? 'Collecting…' : 'Share a diagnostic bundle'}
        </Button>
      </Section>
      {preview.stage === 'preview' || preview.stage === 'uploading' ? (
        <BundlePreview
          state={preview}
          onChange={(text) =>
            preview.stage === 'preview'
              ? setPreview({ ...preview, editedPayload: text })
              : undefined
          }
          onCancel={() => setPreview({ stage: 'idle' })}
          onConfirm={() => void handleConfirmUpload()}
        />
      ) : null}
      {preview.stage === 'sent' ? (
        <TicketReceipt
          ticketId={preview.ticketId}
          copied={copied}
          onCopy={() => void handleCopyTicket()}
          onDismiss={() => setPreview({ stage: 'idle' })}
        />
      ) : null}
      <Separator />
      <Section
        icon={<Globe className="size-4" />}
        title="OTLP export"
        description={
          status?.otlpStatus ??
          'Set ORCA_OTLP_TRACES_URL to point Orca at your own OpenTelemetry collector.'
        }
      >
        <span
          className={
            status?.otlpEnabled
              ? 'text-xs text-green-600 dark:text-green-400'
              : 'text-xs text-muted-foreground'
          }
        >
          {status?.otlpEnabled ? 'Enabled' : 'Disabled'}
        </span>
      </Section>
    </>
  )
}

function DiagnosticsDisabledStateNote({
  reason
}: {
  reason: NonNullable<DiagnosticsStatusPayload['disabledReason']>
}): React.JSX.Element {
  const message =
    reason === 'do_not_track'
      ? 'DO_NOT_TRACK=1 is set — network-bound diagnostics are disabled. The local trace file is still active.'
      : reason === 'orca_telemetry_disabled'
        ? 'ORCA_TELEMETRY_DISABLED=1 is set — network-bound diagnostics are disabled. The local trace file is still active.'
        : reason === 'orca_diagnostics_disabled'
          ? 'ORCA_DIAGNOSTICS_DISABLED=1 is set — every diagnostics surface is off, including local trace writes.'
          : reason === 'ci'
            ? 'Running in CI — diagnostics are off.'
            : 'Diagnostics are disabled by an environment variable.'

  return (
    <div className="rounded border border-dashed border-border/60 bg-card/30 px-3 py-2 text-xs text-muted-foreground">
      {message}
    </div>
  )
}

function Section({
  icon,
  title,
  description,
  children
}: {
  icon: React.ReactNode
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="flex flex-1 items-start gap-3">
        <div className="mt-1 text-muted-foreground">{icon}</div>
        <div className="space-y-1">
          <Label className="text-sm">{title}</Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="shrink-0 self-center">{children}</div>
    </div>
  )
}

function BundlePreview({
  state,
  onChange,
  onCancel,
  onConfirm
}: {
  state: Extract<PreviewState, { stage: 'preview' | 'uploading' }>
  onChange: (text: string) => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const uploading = state.stage === 'uploading'
  return (
    <div className="rounded border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <Label htmlFor="diagnostics-bundle-preview" className="text-xs">
          Bundle preview · {state.bundle.spanCount} span(s) ·{' '}
          {Math.round(state.bundle.bytes / 1024)} KB
        </Label>
        <span className="text-xs text-muted-foreground">ID: {state.bundle.bundleSubmissionId}</span>
      </div>
      <textarea
        id="diagnostics-bundle-preview"
        className="h-72 w-full resize-y rounded border border-border/60 bg-background p-2 font-mono text-[11px] leading-tight"
        value={state.editedPayload}
        readOnly={uploading}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={uploading}>
          Cancel
        </Button>
        <Button size="sm" onClick={onConfirm} disabled={uploading}>
          {uploading ? 'Uploading…' : 'Send to Orca support'}
        </Button>
      </div>
    </div>
  )
}

function TicketReceipt({
  ticketId,
  copied,
  onCopy,
  onDismiss
}: {
  ticketId: string
  copied: boolean
  onCopy: () => void
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="rounded border border-green-600/30 bg-green-500/5 p-3">
      <div className="text-sm font-medium">Bundle uploaded</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Attach this ticket ID to your GitHub issue or support email so the Orca team can find your
        bundle.
      </p>
      <div className="mt-2 flex items-center gap-2 rounded bg-background p-2 font-mono text-xs">
        <span className="flex-1 break-all">{ticketId}</span>
        <Button variant="ghost" size="sm" onClick={onCopy} className="gap-1">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  )
}
