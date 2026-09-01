import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { BuiltInTuiAgent } from '../../../../shared/types'
import { CustomAgentEnvRowsEditor } from './CustomAgentEnvRowsEditor'
import { CustomAgentErrorSummary } from './CustomAgentErrorSummary'
import { BuiltInArgsField, BuiltInCommandField } from './BuiltInLaunchFields'
import { useCustomAgentEditor } from './use-custom-agent-editor'
import {
  AgentSessionSourceHomeInput,
  type AgentSessionSourceHomeControl
} from './codex-session-source-home-control'

export type BuiltInLaunchSettingsDialogProps = {
  open: boolean
  agent: BuiltInTuiAgent
  /** Codex-only session-history source home (host/WSL runtime scoped). Persists
   *  independently via global settings; only shown for the codex harness. */
  codexSessionSourceHome?: AgentSessionSourceHomeControl
  onOpenChange: (open: boolean) => void
  onSaved: (revision: number) => void
}

/** Command/args/env override editor for a shipped built-in. Shares the editor
 *  engine with the custom dialog (built-in-launch mode) but drops the label, base
 *  picker, and paired-env switch, and uses permissive built-in field semantics. */
export function BuiltInLaunchSettingsDialog({
  open,
  agent,
  codexSessionSourceHome,
  onOpenChange,
  onSaved
}: BuiltInLaunchSettingsDialogProps): React.JSX.Element {
  const editor = useCustomAgentEditor({
    open,
    mode: { kind: 'built-in-launch', agent },
    initialBaseAgent: agent,
    onSaved,
    onClose: () => onOpenChange(false)
  })
  const label = getAgentLabel(agent)
  const defaultCmd = getAgentCatalog().find((entry) => entry.id === agent)?.cmd ?? agent

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>
            {translate(
              'auto.components.settings.BuiltInLaunchSettingsDialog.title',
              'Edit launch settings'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.BuiltInLaunchSettingsDialog.description',
              'Set the launch command, arguments, and environment for the {{harness}} harness. Clear a field to restore its default.',
              { harness: label }
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 scrollbar-sleek overflow-y-auto px-6 py-4">
          <CustomAgentErrorSummary
            fieldErrors={editor.fieldErrors}
            formError={editor.formError}
            summaryRef={editor.refs.errorSummaryRef}
          />
          <BuiltInCommandField editor={editor} defaultCmd={defaultCmd} />
          <BuiltInArgsField editor={editor} />
          <CustomAgentEnvRowsEditor editor={editor} />
          {agent === 'codex' && codexSessionSourceHome ? (
            <AgentSessionSourceHomeInput {...codexSessionSourceHome} />
          ) : null}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.CustomAgentEditorDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            className="min-w-24"
            disabled={editor.submitting || editor.loading}
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
