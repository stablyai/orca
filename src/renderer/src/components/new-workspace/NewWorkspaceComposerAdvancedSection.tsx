import React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SettingsSwitch } from '@/components/settings/SettingsFormControls'
import SparseCheckoutPresetSelect from '@/components/sparse/SparseCheckoutPresetSelect'
import { cn } from '@/lib/utils'
import {
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  measureTextControlPasteByteLength,
  pasteTextIntoTextControl,
  shouldHandleTextControlPaste
} from '@/lib/text-control-paste'
import { translate } from '@/i18n/i18n'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

function SetupCommandPreview({
  setupConfig
}: {
  setupConfig: NonNullable<NewWorkspaceComposerCardProps['setupConfig']>
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/60 bg-muted/40 shadow-inner">
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-5 text-foreground/90 scrollbar-sleek">
        {setupConfig.command}
      </pre>
    </div>
  )
}

type NewWorkspaceComposerAdvancedSectionProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'advancedOpen'
  | 'smartNameSelection'
  | 'name'
  | 'onNameValueChange'
  | 'selectedRepoIsGit'
  | 'branchesEnabled'
  | 'branchNameOverride'
  | 'onBranchNameOverrideChange'
  | 'note'
  | 'onNoteChange'
  | 'setupControlsEnabled'
  | 'setupConfig'
  | 'requiresExplicitSetupChoice'
  | 'resolvedSetupDecision'
  | 'onSetupDecisionChange'
  | 'setupAgentStartupPolicy'
  | 'onSetupAgentStartupPolicyChange'
  | 'setupDecision'
  | 'shouldWaitForSetupCheck'
  | 'sparseControlsEnabled'
  | 'repoId'
  | 'sparsePresets'
  | 'sparseSelectedPresetId'
  | 'onSparseSelectPreset'
  | 'canUseSparseCheckout'
> & {
  branchNameInputId: string
  setupConfigLabel: string
  setupRunLabel: string
  setupAskLabel: string
  setupRunButtonLabel: string
  setupSkipButtonLabel: string
  showSetupAgentStartupPolicy: boolean
}

export function NewWorkspaceComposerAdvancedSection({
  advancedOpen,
  smartNameSelection,
  name,
  onNameValueChange,
  selectedRepoIsGit,
  branchesEnabled = true,
  branchNameInputId,
  branchNameOverride,
  onBranchNameOverrideChange,
  note,
  onNoteChange,
  setupControlsEnabled = true,
  setupConfig,
  setupConfigLabel,
  setupRunLabel,
  setupAskLabel,
  setupRunButtonLabel,
  setupSkipButtonLabel,
  requiresExplicitSetupChoice,
  resolvedSetupDecision,
  onSetupDecisionChange,
  showSetupAgentStartupPolicy,
  setupAgentStartupPolicy,
  onSetupAgentStartupPolicyChange,
  setupDecision,
  shouldWaitForSetupCheck,
  sparseControlsEnabled = true,
  repoId,
  sparsePresets,
  sparseSelectedPresetId,
  onSparseSelectPreset,
  canUseSparseCheckout
}: NewWorkspaceComposerAdvancedSectionProps): React.JSX.Element {
  const handleNotePaste = React.useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData('text/plain')
    const byteLengthMeasurement = measureTextControlPasteByteLength(text, {
      stopAfterBytes: TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
    })
    if (
      !byteLengthMeasurement.exceededLimit &&
      !shouldHandleTextControlPaste(text, { measuredByteLength: byteLengthMeasurement.byteLength })
    ) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const textarea = event.currentTarget
    void pasteTextIntoTextControl(textarea, text, {
      source: 'clipboard',
      canContinue: (target) => target.ownerDocument.activeElement === target
    })
      .then((result) => {
        if (result.status === 'rejected' && result.reason === 'too-large') {
          toast.error(
            translate(
              'auto.components.NewWorkspaceComposerCard.notePasteTooLarge',
              'Paste is too large for the note field.'
            )
          )
        }
      })
      .catch(() => {})
  }, [])

  return (
    <div
      className={cn(
        'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
        !advancedOpen && '!mt-2',
        advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
      aria-hidden={!advancedOpen}
      inert={!advancedOpen}
    >
      <div className="min-h-0">
        <div
          className={cn(
            'space-y-4 px-1 pt-1 pb-3 transition-[opacity,transform] duration-150 ease-out',
            advancedOpen
              ? 'translate-y-0 opacity-100 delay-200'
              : '-translate-y-1 opacity-0 delay-0'
          )}
        >
          {smartNameSelection ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {translate('auto.components.NewWorkspaceComposerCard.2688050e4b', 'Name')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(event) => onNameValueChange(event.target.value)}
                placeholder={translate(
                  'auto.components.NewWorkspaceComposerCard.0ee17638fe',
                  'Workspace name'
                )}
                className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
          ) : null}

          {selectedRepoIsGit &&
          branchesEnabled &&
          (!smartNameSelection || smartNameSelection.kind === 'branch') ? (
            <div className="space-y-1">
              <label
                htmlFor={branchNameInputId}
                className="text-xs font-medium text-muted-foreground"
              >
                {translate('auto.components.NewWorkspaceComposerCard.branchName', 'Branch name')}
              </label>
              <input
                id={branchNameInputId}
                type="text"
                value={branchNameOverride ?? ''}
                onChange={(event) => onBranchNameOverrideChange(event.target.value)}
                placeholder={translate(
                  'auto.components.NewWorkspaceComposerCard.branchNamePlaceholder',
                  'feature/my-branch'
                )}
                className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
          ) : null}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {translate('auto.components.NewWorkspaceComposerCard.f8728aa4f9', 'Note')}
            </label>
            <textarea
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
              onPaste={handleNotePaste}
              placeholder={translate(
                'auto.components.NewWorkspaceComposerCard.090cfedeb4',
                'Write a note'
              )}
              rows={1}
              className="w-full min-w-0 resize-none overflow-y-auto scrollbar-sleek rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [field-sizing:content] max-h-40"
            />
          </div>

          {setupControlsEnabled && setupConfig ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-medium text-muted-foreground">
                  {setupConfigLabel}
                </label>
                <span className="rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {setupConfig.source === 'yaml'
                    ? translate('auto.components.NewWorkspaceComposerCard.23bb365554', 'orca.yaml')
                    : setupConfig.source === 'both'
                      ? translate(
                          'auto.components.NewWorkspaceComposerCard.326a578923',
                          'orca.yaml + local'
                        )
                      : translate(
                          'auto.components.NewWorkspaceComposerCard.92e34f0311',
                          'local settings'
                        )}
                </span>
              </div>

              <SetupCommandPreview setupConfig={setupConfig} />

              {!requiresExplicitSetupChoice || showSetupAgentStartupPolicy ? (
                <div className="rounded-md border border-border/60 bg-muted/25">
                  {requiresExplicitSetupChoice ? null : (
                    <div className="flex items-center justify-between gap-3 p-3">
                      <span className="text-xs font-medium text-foreground">{setupRunLabel}</span>
                      <SettingsSwitch
                        checked={resolvedSetupDecision === 'run'}
                        onChange={() =>
                          onSetupDecisionChange(resolvedSetupDecision === 'run' ? 'skip' : 'run')
                        }
                        ariaLabel={setupRunLabel}
                      />
                    </div>
                  )}
                  {showSetupAgentStartupPolicy ? (
                    <div className="flex items-start justify-between gap-3 p-3">
                      <span
                        className={cn(
                          'min-w-0 space-y-1',
                          resolvedSetupDecision === 'run' ? '' : 'opacity-50'
                        )}
                      >
                        <span className="block text-xs font-medium text-foreground">
                          {translate(
                            'auto.components.NewWorkspaceComposerCard.waitForSetupBeforeAgent',
                            'Wait for setup to complete before starting agent'
                          )}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {translate(
                            'auto.components.NewWorkspaceComposerCard.waitForSetupBeforeAgentHelp',
                            'Turn this on when setup installs dependencies, MCP servers, or config files the agent needs during startup.'
                          )}
                        </span>
                      </span>
                      <SettingsSwitch
                        checked={setupAgentStartupPolicy === 'wait-for-setup'}
                        disabled={resolvedSetupDecision !== 'run'}
                        onChange={() =>
                          onSetupAgentStartupPolicyChange(
                            setupAgentStartupPolicy === 'wait-for-setup'
                              ? 'start-immediately'
                              : 'wait-for-setup'
                          )
                        }
                        ariaLabel={translate(
                          'auto.components.NewWorkspaceComposerCard.waitForSetupBeforeAgent',
                          'Wait for setup to complete before starting agent'
                        )}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {requiresExplicitSetupChoice ? (
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    {setupAskLabel}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={() => onSetupDecisionChange('run')}
                      variant={setupDecision === 'run' ? 'default' : 'outline'}
                      size="sm"
                    >
                      {setupRunButtonLabel}
                    </Button>
                    <Button
                      type="button"
                      onClick={() => onSetupDecisionChange('skip')}
                      variant={setupDecision === 'skip' ? 'secondary' : 'outline'}
                      size="sm"
                    >
                      {setupSkipButtonLabel}
                    </Button>
                  </div>
                  {!setupDecision ? (
                    <div className="text-xs text-muted-foreground">
                      {shouldWaitForSetupCheck
                        ? translate(
                            'auto.components.NewWorkspaceComposerCard.803b7fe72f',
                            'Checking setup configuration...'
                          )
                        : translate(
                            'auto.components.NewWorkspaceComposerCard.9a70e4859e',
                            'Choose whether to run setup before creating this workspace.'
                          )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {sparseControlsEnabled ? (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {translate(
                  'auto.components.NewWorkspaceComposerCard.d861de981b',
                  'Sparse checkout'
                )}
              </label>
              <SparseCheckoutPresetSelect
                repoId={repoId}
                presets={sparsePresets}
                selectedPresetId={sparseSelectedPresetId}
                onSelectPreset={onSparseSelectPreset}
                disabled={!canUseSparseCheckout}
              />
              {!canUseSparseCheckout ? (
                <p className="text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.NewWorkspaceComposerCard.cbb47ee0dc',
                    'Only available for local Git projects.'
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
