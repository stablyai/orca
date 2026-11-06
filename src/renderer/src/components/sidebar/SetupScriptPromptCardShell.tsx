import { useState } from 'react'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import {
  ConfigureOnlyAction,
  DetectedSetupPreview,
  DetectedSetupSummary,
  DismissButton,
  InspectionErrorActions,
  PackageManagerActions,
  ReviewSetupAction,
  SetupScriptPromptBody
} from './SetupScriptPromptCardViews'
import { SetupScriptReviewDialog } from './SetupScriptReviewDialog'
import { translate } from '@/i18n/i18n'
import type { DetectedSetupPreviewContent } from '@/lib/setup-script-prompt'

type SetupScriptPromptCardShellProps = {
  repoBadgeColor: string
  repoDisplayName: string
  isInspectionError: boolean
  sharedSetupIgnored: boolean
  isPackageManagerSuggestion: boolean
  candidateSource: string | null
  candidateProvenance: string | null
  detectedSetupPreview: DetectedSetupPreviewContent | null
  isImporting: boolean
  renderedStateOk: boolean
  onDismiss: () => void
  onRetryInspection: () => void
  onConfigure: () => void
  onImport: () => void
  onSetupDraftChange: (value: string) => void
}

export function SetupScriptPromptCardShell({
  repoBadgeColor,
  repoDisplayName,
  isInspectionError,
  sharedSetupIgnored,
  isPackageManagerSuggestion,
  candidateSource,
  candidateProvenance,
  detectedSetupPreview,
  isImporting,
  renderedStateOk,
  onDismiss,
  onRetryInspection,
  onConfigure,
  onImport,
  onSetupDraftChange
}: SetupScriptPromptCardShellProps): React.JSX.Element {
  const [reviewOpen, setReviewOpen] = useState(false)
  const showDetected = !isInspectionError && !sharedSetupIgnored && detectedSetupPreview !== null
  return (
    <div
      data-setup-script-prompt-layer=""
      className="pointer-events-none absolute inset-x-0 bottom-full z-40 px-3 pb-2"
    >
      <div className="pointer-events-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold leading-snug">
            {translate(
              'auto.components.sidebar.SetupScriptPromptCard.ff1e819a11',
              'Add a setup script'
            )}
          </p>
          <DismissButton onDismiss={onDismiss} />
        </div>

        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <RepoBadgeMark color={repoBadgeColor} />
          <span className="truncate font-medium text-foreground">{repoDisplayName}</span>
        </p>

        <p className="mt-1 text-xs leading-snug text-muted-foreground">
          <SetupScriptPromptBody
            isInspectionError={isInspectionError}
            sharedSetupIgnored={sharedSetupIgnored}
            isPackageManagerSuggestion={isPackageManagerSuggestion}
            candidateSource={candidateSource}
          />
        </p>

        {showDetected && detectedSetupPreview.editable ? (
          <DetectedSetupPreview
            setup={detectedSetupPreview.setup}
            onSetupChange={onSetupDraftChange}
            provenance={candidateProvenance}
          />
        ) : showDetected ? (
          <DetectedSetupSummary
            setup={detectedSetupPreview.setup}
            provenance={candidateProvenance}
          />
        ) : null}

        {isInspectionError ? (
          <InspectionErrorActions onRetry={onRetryInspection} onConfigure={onConfigure} />
        ) : sharedSetupIgnored ? (
          <ConfigureOnlyAction onConfigure={onConfigure} />
        ) : detectedSetupPreview && isPackageManagerSuggestion ? (
          <PackageManagerActions
            isSaving={isImporting}
            onSave={onImport}
            onConfigure={onConfigure}
          />
        ) : detectedSetupPreview ? (
          <ReviewSetupAction onReview={() => setReviewOpen(true)} />
        ) : renderedStateOk ? (
          <ConfigureOnlyAction onConfigure={onConfigure} />
        ) : null}
      </div>
      {/* Imported scripts are saved verbatim, so saving only happens after the full text is on screen. */}
      {showDetected && !detectedSetupPreview.editable ? (
        <SetupScriptReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          repoDisplayName={repoDisplayName}
          setup={detectedSetupPreview.setup}
          archive={detectedSetupPreview.archive}
          provenance={candidateProvenance}
          isSaving={isImporting}
          onSave={onImport}
        />
      ) : null}
    </div>
  )
}
