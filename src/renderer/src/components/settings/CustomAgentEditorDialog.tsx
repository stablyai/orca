import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { getAgentLabel, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { BuiltInTuiAgent } from '../../../../shared/types'
import { SettingsSwitchRow } from './SettingsFormControls'
import { CustomAgentArgsField } from './CustomAgentArgsField'
import { CustomAgentEnvRowsEditor } from './CustomAgentEnvRowsEditor'
import { CustomAgentErrorSummary } from './CustomAgentErrorSummary'
import { CustomAgentIdentityFields } from './CustomAgentIdentityFields'
import type { CustomAgentEditorMode } from './custom-agent-editor-state'
import { useCustomAgentEditor } from './use-custom-agent-editor'

/** The custom-agent dialog handles new/edit/duplicate only; built-in launch
 *  settings have their own dialog, so that mode never reaches here. */
export type CustomAgentDialogMode = Exclude<CustomAgentEditorMode, { kind: 'built-in-launch' }>

export type CustomAgentEditorDialogProps = {
  open: boolean
  mode: CustomAgentDialogMode
  /** Built-in catalog entries for the create-mode base picker and the read-only tile. */
  baseAgentOptions: readonly AgentCatalogEntry[]
  onOpenChange: (open: boolean) => void
  onSaved: (revision: number) => void
}

export function CustomAgentEditorDialog({
  open,
  mode,
  baseAgentOptions,
  onOpenChange,
  onSaved
}: CustomAgentEditorDialogProps): React.JSX.Element {
  const initialBaseAgent = (baseAgentOptions[0]?.id ?? 'claude') as BuiltInTuiAgent
  const editor = useCustomAgentEditor({
    open,
    mode,
    initialBaseAgent,
    onSaved,
    onClose: () => onOpenChange(false)
  })
  const baseLabel = getAgentLabel(editor.baseAgent)
  const isDuplicate = mode.kind === 'duplicate'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          editor.refs.nameInputRef.current?.focus()
        }}
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>{dialogTitle(mode)}</DialogTitle>
          <DialogDescription>{dialogDescription(mode, baseLabel)}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 scrollbar-sleek overflow-y-auto px-6 py-4">
          <CustomAgentErrorSummary
            fieldErrors={editor.fieldErrors}
            formError={editor.formError}
            summaryRef={editor.refs.errorSummaryRef}
          />
          <CustomAgentIdentityFields
            editor={editor}
            mode={mode}
            baseAgentOptions={baseAgentOptions}
            baseLabel={baseLabel}
          />
          {isDuplicate ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.CustomAgentEditorDialog.duplicateNote',
                "This copies the source agent's configuration into a new agent. Paired-launch env sharing is turned off for the copy."
              )}
            </p>
          ) : (
            <>
              <CustomAgentArgsField editor={editor} />
              <CustomAgentEnvRowsEditor editor={editor} />
              <SettingsSwitchRow
                checked={editor.draft.syncEnv}
                onChange={() => editor.updateField({ syncEnv: !editor.draft.syncEnv })}
                label={translate(
                  'auto.components.settings.CustomAgentEditorDialog.syncEnvLabel',
                  'Allow paired-device launches to use these environment values'
                )}
                description={translate(
                  'auto.components.settings.CustomAgentEditorDialog.syncEnvDescription',
                  'Orca does not send the values as settings to the paired device. The launched process can access — and may print — them in its terminal.'
                )}
              />
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CustomAgentEditorDialog.pairedVisibilityWarning',
                  'The agent name, executable, and arguments are visible to paired devices; do not put secrets in them.'
                )}
              </p>
            </>
          )}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.CustomAgentEditorDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            className="min-w-24"
            disabled={editor.submitting || editor.inputsLocked}
            onClick={() => void editor.submit()}
          >
            {editor.showSaving
              ? translate('auto.components.settings.CustomAgentEditorDialog.saving', 'Saving…')
              : translate('auto.components.settings.CustomAgentEditorDialog.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function dialogTitle(mode: CustomAgentDialogMode): string {
  switch (mode.kind) {
    case 'new':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.titleNew',
        'New custom agent'
      )
    case 'edit':
    case 'repair-edit':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.titleEdit',
        'Edit custom agent'
      )
    case 'duplicate':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.titleDuplicate',
        'Duplicate agent'
      )
    case 'repair-replace':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.titleRepairReplace',
        'Replace corrupt agent'
      )
  }
}

function dialogDescription(mode: CustomAgentDialogMode, baseLabel: string): string {
  if (mode.kind === 'duplicate') {
    return translate(
      'auto.components.settings.CustomAgentEditorDialog.descriptionDuplicate',
      'Create a copy under a new name.'
    )
  }
  if (mode.kind === 'repair-edit') {
    return translate(
      'auto.components.settings.CustomAgentEditorDialog.descriptionRepairEdit',
      'Fix the invalid values below to make this {{harness}} agent launchable again.',
      { harness: baseLabel }
    )
  }
  if (mode.kind === 'repair-replace') {
    return translate(
      'auto.components.settings.CustomAgentEditorDialog.descriptionRepairReplace',
      'Save a new agent to replace the corrupt one. Saved references are not rebound to the new agent.'
    )
  }
  return translate(
    'auto.components.settings.CustomAgentEditorDialog.descriptionCreateEdit',
    'Save alternate arguments and environment for the {{harness}} harness.',
    { harness: baseLabel }
  )
}
