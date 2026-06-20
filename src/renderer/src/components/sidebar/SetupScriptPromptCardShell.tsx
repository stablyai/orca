import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import {
  ConfigureOnlyAction,
  DetectedSetupPreview,
  DismissButton,
  InspectionErrorActions,
  PackageManagerActions,
  SaveLocalSetupAction,
  SetupScriptPromptBody
} from './SetupScriptPromptCardViews'
import { translate } from '@/i18n/i18n'

type SetupScriptPromptCardShellProps = {
  repoBadgeColor: string
  repoDisplayName: string
  isInspectionError: boolean
  sharedSetupIgnored: boolean
  isPackageManagerSuggestion: boolean
  hasCandidate: boolean
  candidateSource: string | null
  candidateProvenance: string | null
  detectedSetupDraft: string
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
  hasCandidate,
  candidateSource,
  candidateProvenance,
  detectedSetupDraft,
  isImporting,
  renderedStateOk,
  onDismiss,
  onRetryInspection,
  onConfigure,
  onImport,
  onSetupDraftChange
}: SetupScriptPromptCardShellProps): React.JSX.Element {
  return (
    <div className="shrink-0 px-3 pb-2">
      <div className="setup-script-prompt-card rounded-lg border border-worktree-sidebar-border p-3 text-worktree-sidebar-accent-foreground shadow-xs">
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

        {!isInspectionError && !sharedSetupIgnored && hasCandidate && isPackageManagerSuggestion ? (
          <DetectedSetupPreview
            setup={detectedSetupDraft}
            onSetupChange={onSetupDraftChange}
            provenance={candidateProvenance}
          />
        ) : null}

        {isInspectionError ? (
          <InspectionErrorActions onRetry={onRetryInspection} onConfigure={onConfigure} />
        ) : sharedSetupIgnored ? (
          <ConfigureOnlyAction onConfigure={onConfigure} />
        ) : hasCandidate && isPackageManagerSuggestion ? (
          <PackageManagerActions
            isSaving={isImporting}
            onSave={onImport}
            onConfigure={onConfigure}
          />
        ) : hasCandidate ? (
          <SaveLocalSetupAction isSaving={isImporting} onSave={onImport} />
        ) : renderedStateOk ? (
          <ConfigureOnlyAction onConfigure={onConfigure} />
        ) : null}
      </div>
    </div>
  )
}
