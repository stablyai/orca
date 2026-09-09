/**
 * The Office document surface: chrome, a rendered snapshot, and the controls that move between a
 * snapshot and a live preview.
 *
 * It is a sibling of `HtmlDocPreview`, not a mode inside it. The two share the pieces that matter
 * — the fenced preview partition, the webview attach, the document chip — but an Office document
 * has no address to edit, no in-document history, and a whole render step before there is
 * anything to show, and folding that into the HTML surface would make both harder to read.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { selectWorktreeHostDisplayLabel } from '@/lib/execution-host-display-label'
import { startOfficeLivePreview } from '@/lib/office-live-preview'
import {
  resolveOfficePreviewRouting,
  useOfficeDocumentLocation,
  useOfficeHostOwner
} from '@/lib/office-preview-plan'
import {
  handOffOfficeSelection,
  reportOfficeSelectionHandoff
} from '@/lib/office-selection-handoff'
import { useAppStore } from '@/store'
import { officeKindSupportsSelection } from '../../../../../shared/office-file-extensions'
import { buildDocPreviewDocumentIdentity } from './doc-preview-document-identity'
import { openDocPreviewExternally } from './doc-preview-document-actions'
import { OfficeMarksPanel } from './office-marks-panel'
import { OfficeMissingBinaryNotice } from './office-missing-binary-notice'
import { OfficePreviewFailurePanel, OfficeUnrenderablePanel } from './office-preview-failure-panel'
import { isTerminalOfficeRefusal, officeRefreshState } from './office-preview-refresh-state'
import {
  officeSelectionUnavailableReason,
  officeUnrenderableMessage
} from './office-preview-status'
import { OfficePreviewToolbar } from './office-preview-toolbar'
import { useOfficeDocumentChange } from './use-office-document-change'
import { useOfficeProbe } from './use-office-probe'
import { useOfficeSnapshot } from './use-office-snapshot'

export function OfficePreviewPane({
  previewId,
  workspaceId,
  filePath,
  relativePath,
  worktreeId,
  runtimeEnvironmentId
}: {
  previewId: string
  workspaceId: string
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId: string | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [liveStarting, setLiveStarting] = useState(false)
  const [liveFailure, setLiveFailure] = useState<string | null>(null)

  const routing = useMemo(() => resolveOfficePreviewRouting(filePath), [filePath])
  const owner = useOfficeHostOwner(worktreeId, filePath)
  // The host resolves documents as (workspace root, path inside it) and refuses anything that
  // canonicalises outside the root, so the renderer never hands it a bare absolute path.
  const documentLocation = useOfficeDocumentLocation(worktreeId, filePath)
  const worktreeRoot = useAppStore((store) => store.getKnownWorktreeById(worktreeId)?.path ?? null)
  const hostLabel = useAppStore((store) => selectWorktreeHostDisplayLabel(store, worktreeId))
  const identity = useMemo(
    () => buildDocPreviewDocumentIdentity({ filePath, worktreeRoot, hostLabel }),
    [filePath, hostLabel, worktreeRoot]
  )
  const previewDocument = useMemo(
    () => ({
      filePath,
      relativePath,
      worktreeId,
      runtimeEnvironmentId,
      externalSshTargetId: null
    }),
    [filePath, relativePath, runtimeEnvironmentId, worktreeId]
  )

  const change = useOfficeDocumentChange({ worktreeId, filePath, owner })
  const renderable = routing.status === 'renderable'
  const snapshot = useOfficeSnapshot({
    previewId,
    document: documentLocation,
    owner,
    containerRef,
    enabled: renderable,
    onRendered: change.consume
  })

  const failureCode = snapshot.state.status === 'failed' ? snapshot.state.code : null
  // Probed for every renderable document, not only after a failure: the Live toggle has to state
  // why it is unavailable rather than let the reader discover it by clicking, and the host's own
  // platform — never this machine's — is what decides which install command the notice shows.
  // The host caches the answer per lane, so this is one cheap round trip.
  const probe = useOfficeProbe({ owner, document: documentLocation, enabled: renderable })
  const refreshState = officeRefreshState({
    renderable,
    terminallyRefused: isTerminalOfficeRefusal(failureCode),
    addressable: owner !== null && documentLocation !== null,
    changedOnDisk: change.changed,
    busy: snapshot.state.status === 'rendering'
  })

  const openExternally = useCallback(
    () => openDocPreviewExternally(previewDocument),
    [previewDocument]
  )
  const revealInFolder = useMemo(
    () =>
      owner?.kind === 'local'
        ? () => void window.api.shell.openInFileManager(filePath)
        : // A path on another machine has no folder this OS can open, and pretending otherwise
          // would reveal an unrelated local file of the same name.
          null,
    [filePath, owner]
  )

  const handleRefresh = useCallback(() => {
    change.consume()
    snapshot.rerender()
  }, [change, snapshot])

  const handleToggleLive = useCallback(() => {
    if (!owner || !documentLocation || liveStarting) {
      return
    }
    setLiveStarting(true)
    setLiveFailure(null)
    void startOfficeLivePreview({
      pageId: previewId,
      workspaceId,
      worktreeId,
      owner,
      document: documentLocation,
      browserRuntimeEnvironmentId: owner.kind === 'runtime' ? owner.environmentId : null
    })
      .then((result) => {
        setLiveStarting(false)
        if (!result.ok) {
          // Falling back to the snapshot is silent and automatic; only the reason is surfaced, on
          // the control the reader just used.
          setLiveFailure(result.code)
        }
      })
      .catch(() => setLiveStarting(false))
  }, [documentLocation, liveStarting, owner, previewId, workspaceId, worktreeId])

  // Re-probes with the host's cache dropped, then re-renders: a cached "not installed" surviving
  // the install the reader just ran is how a preview keeps asking for what already happened.
  const handleRetryAfterInstall = useCallback(() => {
    probe.refresh()
    snapshot.rerender()
  }, [probe, snapshot])

  const handleUseSelection = useCallback(() => {
    if (!owner || !documentLocation) {
      return
    }
    void handOffOfficeSelection({
      worktreeId,
      owner,
      document: documentLocation,
      displayPath: filePath
    }).then(reportOfficeSelectionHandoff)
  }, [documentLocation, filePath, owner, worktreeId])

  if (routing.status !== 'renderable') {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-editor-surface">
        <OfficeUnrenderablePanel
          message={officeUnrenderableMessage(
            routing.status === 'unrenderable' ? routing.extension : ''
          )}
          onOpenExternally={openExternally}
          onRevealInFolder={revealInFolder}
        />
      </div>
    )
  }

  const liveDisabledReason = liveStarting
    ? translate('auto.components.office.preview.liveStarting', 'Starting the live preview…')
    : !owner
      ? translate(
          'auto.components.office.preview.liveNoHost',
          'Orca cannot tell which machine owns this document.'
        )
      : failureCode === 'OFFICECLI_NOT_FOUND' || (probe.answered && !probe.installed)
        ? translate(
            'auto.components.office.preview.liveNoBinary',
            'officecli is not installed on the machine that owns this document.'
          )
        : probe.answered && !probe.supportsWatch
          ? translate(
              'auto.components.office.preview.liveNoWatch',
              'The officecli on that machine is too old to serve a live preview.'
            )
          : liveFailure
            ? translate(
                'auto.components.office.preview.liveFailed',
                'The live preview could not start. Showing the snapshot.'
              )
            : null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-editor-surface">
      <OfficePreviewToolbar
        identity={identity}
        kind={routing.kind}
        refreshState={refreshState}
        onRefresh={handleRefresh}
        live={false}
        onToggleLive={handleToggleLive}
        liveDisabledReason={liveDisabledReason}
        selection={{
          enabled: officeKindSupportsSelection(routing.kind) && owner !== null,
          reason: officeSelectionUnavailableReason(routing.kind),
          onUse: handleUseSelection
        }}
        onOpenExternally={openExternally}
        onRevealInFolder={revealInFolder}
      />
      <OfficeMarksPanel owner={owner} document={documentLocation} />
      <div className="relative flex min-h-0 flex-1 overflow-hidden" ref={containerRef}>
        {snapshot.state.status === 'rendering' ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-editor-surface">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {snapshot.state.status === 'failed' ? (
          <div className="absolute inset-0 z-10 flex bg-editor-surface">
            {snapshot.state.code === 'OFFICECLI_NOT_FOUND' ? (
              <OfficeMissingBinaryNotice
                worktreeId={worktreeId}
                hostLabel={hostLabel}
                platform={probe.platform}
                onRetry={handleRetryAfterInstall}
                retrying={probe.refreshing}
              />
            ) : (
              <OfficePreviewFailurePanel
                code={snapshot.state.code}
                {...(snapshot.state.detail ? { detail: snapshot.state.detail } : {})}
                hostLabel={hostLabel}
                onRetry={isTerminalOfficeRefusal(snapshot.state.code) ? null : snapshot.rerender}
                onOpenExternally={openExternally}
              />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
