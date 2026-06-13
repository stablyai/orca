import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FileText, Folder, Globe, Trash2 } from 'lucide-react'
import type {
  DiagnosticsBundlePayload,
  DiagnosticsStatusPayload
} from '../../../../preload/api-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import {
  getDiagnosticBundleDescription,
  PrivacyDiagnosticBundleControls
} from './PrivacyDiagnosticBundleControls'
import { translate } from '@/i18n/i18n'

export function PrivacyDiagnosticsSection(): React.JSX.Element {
  const [status, setStatus] = useState<DiagnosticsStatusPayload | null>(null)
  const [bundle, setBundle] = useState<DiagnosticsBundlePayload | null>(null)
  const [previewOpened, setPreviewOpened] = useState(false)
  const [ticketId, setTicketId] = useState<string | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [openingPreview, setOpeningPreview] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [copyingTicket, setCopyingTicket] = useState(false)
  const [deletingTicket, setDeletingTicket] = useState(false)
  const mountedRef = useRef(true)
  const activeBundleSubmissionIdRef = useRef<string | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.diagnostics.getStatus()
      if (mountedRef.current) {
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
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (activeBundleSubmissionIdRef.current) {
        void window.api.diagnostics.discardBundlePreview(activeBundleSubmissionIdRef.current)
      }
    }
  }, [])

  const handleOpenFolder = useCallback(async (): Promise<void> => {
    try {
      await window.api.diagnostics.openTraceFolder()
    } catch {
      toast.error(translate("auto.components.settings.PrivacyDiagnosticsSection.b85fe972cd", "Could not open trace folder"))
    }
  }, [])

  const handleClear = useCallback(async (): Promise<void> => {
    try {
      await window.api.diagnostics.clearTraces()
      if (!mountedRef.current) {
        return
      }
      activeBundleSubmissionIdRef.current = null
      setBundle(null)
      setPreviewOpened(false)
      setTicketId(null)
      await refreshStatus()
      toast.success(translate("auto.components.settings.PrivacyDiagnosticsSection.32d767f84d", "Local trace files cleared"))
    } catch {
      if (mountedRef.current) {
        toast.error(translate("auto.components.settings.PrivacyDiagnosticsSection.9666a05580", "Could not clear trace files"))
      }
    }
  }, [refreshStatus])

  const handleCollectBundle = useCallback(async (): Promise<void> => {
    setCollecting(true)
    try {
      const nextBundle = await window.api.diagnostics.collectBundle()
      if (!mountedRef.current) {
        await window.api.diagnostics.discardBundlePreview(nextBundle.bundleSubmissionId)
        return
      }
      // Why: unmount cleanup may run before a passive ref mirror would fire;
      // keep the retained preview id in sync at the creation/clear sites.
      activeBundleSubmissionIdRef.current = nextBundle.bundleSubmissionId
      setBundle(nextBundle)
      setPreviewOpened(false)
      setTicketId(null)
      toast.success(translate("auto.components.settings.PrivacyDiagnosticsSection.a2b3505c77", "Diagnostic bundle preview created"))
    } catch (error) {
      if (mountedRef.current) {
        toast.error(getDiagnosticsErrorMessage(error, 'Could not create diagnostic bundle'))
      }
    } finally {
      if (mountedRef.current) {
        setCollecting(false)
      }
    }
  }, [])

  const handleOpenPreview = useCallback(async (): Promise<void> => {
    if (!bundle) {
      return
    }
    setOpeningPreview(true)
    try {
      await window.api.diagnostics.openBundlePreview(bundle.bundleSubmissionId)
      if (!mountedRef.current) {
        return
      }
      setPreviewOpened(true)
      toast.success(translate("auto.components.settings.PrivacyDiagnosticsSection.db3228e01a", "Diagnostic bundle preview opened"))
    } catch (error) {
      if (mountedRef.current) {
        toast.error(getDiagnosticsErrorMessage(error, 'Could not open diagnostic bundle preview'))
      }
    } finally {
      if (mountedRef.current) {
        setOpeningPreview(false)
      }
    }
  }, [bundle])

  const handleUploadBundle = useCallback(async (): Promise<void> => {
    if (!bundle) {
      return
    }
    setUploading(true)
    try {
      const upload = await window.api.diagnostics.uploadBundle(bundle.bundleSubmissionId)
      if (!mountedRef.current) {
        return
      }
      activeBundleSubmissionIdRef.current = null
      setBundle(null)
      setPreviewOpened(false)
      setTicketId(upload.ticketId)
      toast.success(translate("auto.components.settings.PrivacyDiagnosticsSection.49fc6c80e8", "Diagnostic bundle uploaded"))
    } catch (error) {
      if (mountedRef.current) {
        toast.error(getDiagnosticsErrorMessage(error, 'Could not upload diagnostic bundle'))
      }
    } finally {
      if (mountedRef.current) {
        setUploading(false)
      }
    }
  }, [bundle])

  const handleDiscardBundle = useCallback(async (): Promise<void> => {
    if (!bundle) {
      return
    }
    setDiscarding(true)
    try {
      await window.api.diagnostics.discardBundlePreview(bundle.bundleSubmissionId)
      if (!mountedRef.current) {
        return
      }
      activeBundleSubmissionIdRef.current = null
      setBundle(null)
      setPreviewOpened(false)
      toast.success(translate("auto.components.settings.PrivacyDiagnosticsSection.860bca9ec9", "Diagnostic bundle preview discarded"))
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          getDiagnosticsErrorMessage(error, 'Could not discard diagnostic bundle preview')
        )
      }
    } finally {
      if (mountedRef.current) {
        setDiscarding(false)
      }
    }
  }, [bundle])

  const handleCopyTicket = useCallback(async (): Promise<void> => {
    if (!ticketId) {
      return
    }
    setCopyingTicket(true)
    try {
      await window.api.ui.writeClipboardText(ticketId)
      if (!mountedRef.current) {
        return
      }
      toast.success(translate("auto.components.settings.PrivacyDiagnosticsSection.13eb2c65a1", "Diagnostic ticket copied"))
    } catch {
      if (mountedRef.current) {
        toast.error(translate("auto.components.settings.PrivacyDiagnosticsSection.7a4944595b", "Could not copy diagnostic ticket"))
      }
    } finally {
      if (mountedRef.current) {
        setCopyingTicket(false)
      }
    }
  }, [ticketId])

  const handleDeleteUploadedBundle = useCallback(async (): Promise<void> => {
    if (!ticketId) {
      return
    }
    setDeletingTicket(true)
    try {
      await window.api.diagnostics.deleteBundle(ticketId)
      if (!mountedRef.current) {
        return
      }
      setTicketId(null)
      toast.success(translate("auto.components.settings.PrivacyDiagnosticsSection.c18cbe45df", "Uploaded diagnostic bundle deleted"))
    } catch (error) {
      if (mountedRef.current) {
        toast.error(getDiagnosticsErrorMessage(error, 'Could not delete diagnostic bundle'))
      }
    } finally {
      if (mountedRef.current) {
        setDeletingTicket(false)
      }
    }
  }, [ticketId])

  return (
    <>
      {status?.disabledReason ? (
        <DiagnosticsDisabledStateNote reason={status.disabledReason} />
      ) : null}
      <Separator />
      <Section
        icon={<FileText className="size-4" />}
        title={translate("auto.components.settings.PrivacyDiagnosticsSection.af2fc82cde", "Diagnostic bundle")}
        description={getDiagnosticBundleDescription({ bundle, previewOpened, ticketId })}
      >
        <PrivacyDiagnosticBundleControls
          status={status}
          bundle={bundle}
          previewOpened={previewOpened}
          ticketId={ticketId}
          collecting={collecting}
          openingPreview={openingPreview}
          uploading={uploading}
          discarding={discarding}
          copyingTicket={copyingTicket}
          deletingTicket={deletingTicket}
          onCollect={handleCollectBundle}
          onOpenPreview={handleOpenPreview}
          onUpload={handleUploadBundle}
          onDiscard={handleDiscardBundle}
          onCopyTicket={handleCopyTicket}
          onDeleteUploadedBundle={handleDeleteUploadedBundle}
          onDismissTicket={() => setTicketId(null)}
        />
      </Section>
      <Separator />
      <Section
        icon={<Folder className="size-4" />}
        title={translate("auto.components.settings.PrivacyDiagnosticsSection.fe81a52cb2", "Open trace folder")}
        description={translate("auto.components.settings.PrivacyDiagnosticsSection.5ff57fc986", "Reveals {{value0}} in your file manager.", { value0: status?.traceFilePath || 'the trace folder' })}
      >
        <Button variant="outline" size="sm" onClick={() => void handleOpenFolder()}>
          {translate("auto.components.settings.PrivacyDiagnosticsSection.fe81a52cb2", "Open trace folder")}</Button>
      </Section>
      <Separator />
      <Section
        icon={<Trash2 className="size-4" />}
        title={translate("auto.components.settings.PrivacyDiagnosticsSection.4ff08ff3a7", "Clear local traces")}
        description={translate("auto.components.settings.PrivacyDiagnosticsSection.9ca08a9f8f", "Deletes every rotated trace file on this machine.")}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!status?.localFileEnabled}
          onClick={() => void handleClear()}
        >
          {translate("auto.components.settings.PrivacyDiagnosticsSection.4ff08ff3a7", "Clear local traces")}</Button>
      </Section>
      <Separator />
      <Section
        icon={<Globe className="size-4" />}
        title={translate("auto.components.settings.PrivacyDiagnosticsSection.acc7c66e6e", "OTLP export")}
        description={
          status?.otlpStatus ??
          translate("auto.components.settings.PrivacyDiagnosticsSection.7c9d9820b6", "Set ORCA_OTLP_TRACES_URL to point Orca at your own OpenTelemetry collector.")
        }
      >
        <span
          className={
            status?.otlpEnabled
              ? 'text-xs font-medium text-foreground'
              : 'text-xs text-muted-foreground'
          }
        >
          {status?.otlpEnabled ? translate("auto.components.settings.PrivacyDiagnosticsSection.46ea3fb2d0", "Enabled") : translate("auto.components.settings.PrivacyDiagnosticsSection.1fb00a8995", "Disabled")}
        </span>
      </Section>
    </>
  )
}

function getDiagnosticsErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
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
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div className="min-w-0 space-y-0.5">
          <Label className="text-sm">{title}</Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  )
}
