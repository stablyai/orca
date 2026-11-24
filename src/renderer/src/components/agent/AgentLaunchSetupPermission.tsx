import { AgentPermissionMenu } from './launch-settings/AgentPermissionMenu'
import type { AgentPickerEdit } from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

/** A kept setup's permission row in the picker card: its own modes and the inherited default,
 *  which clears its pick. Launch setups keep Permissions as a field under the picker instead. */
export function AgentLaunchSetupPermission({
  entry,
  draft,
  disabled,
  onEdit
}: {
  entry: AgentPickerEntry
  draft: AgentPickerDraft
  disabled?: boolean
  onEdit: (edit: AgentPickerEdit) => void
}): React.JSX.Element | null {
  const permissions = entry.keptSetup?.permissions
  if (!permissions) {
    return null
  }
  const picked = permissions.find((mode) => mode === draft.choices.permissionMode)
  const inherited = entry.structured.permissionMode ?? 'own'
  return (
    <div className="shrink-0 border-t border-border px-2.5 py-1.5">
      <AgentPermissionMenu
        agentId={entry.agent}
        label={entry.label}
        layout="row"
        inheritLabel={entry.keptSetup?.inheritLabel}
        disabled={disabled || !permissions.length}
        permission={{
          choice: picked ?? inherited,
          defaultChoice: inherited,
          choices: permissions,
          source: picked ? 'agent' : 'all',
          flag: '',
          argsSetPermission: false,
          onSelect: (choice) =>
            onEdit(
              choice === 'default'
                ? { kind: 'choice', patch: { permissionMode: 'default' } }
                : { kind: 'permission', value: choice }
            )
        }}
      />
    </div>
  )
}
