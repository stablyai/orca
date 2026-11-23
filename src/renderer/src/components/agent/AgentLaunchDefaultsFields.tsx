import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { AgentDefaultArgsInput } from './launch-settings/AgentLaunchDefaultsEditor'
import { AgentPermissionMenu } from './launch-settings/AgentPermissionMenu'
import { agentModelChoiceChips } from './launch-settings/agent-model-choice-chips'
import { agentLaunchSetupState } from './agent-launch-setup-state'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import { agentPickerPanelArguments } from '../../../../shared/agent-launch/picker/agent-launch-picker-arguments'
import {
  agentPickerArgumentsKnown,
  currentAgentPickerDraft
} from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import {
  agentPickerEntryOptions,
  agentPickerPermissions
} from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit,
  type AgentPickerEdit
} from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type {
  AgentPickerDraft,
  AgentPickerEntry,
  AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

function agentLaunchArgumentsNote(
  label: string,
  options: ReturnType<typeof agentPickerEntryOptions>,
  noModelFlag: boolean,
  t: Translate = translate
) {
  const composed = options.some((option) => option.apply.composedIntoModel)
  const noOptionFlag = options.some(
    (option) => !option.apply.cli?.length && !option.apply.composedIntoModel
  )
  return noModelFlag || noOptionFlag
    ? t(
        'agentPicker.chatChoicesNote',
        '{{agent}} model or effort choices without a CLI flag apply to chats.',
        { agent: label }
      )
    : composed
      ? t(
          'agentPicker.composedChoicesNote',
          '{{agent}} effort and speed choices are included in the model argument.',
          { agent: label }
        )
      : undefined
}

/** A saved launch setup's Permissions and Arguments, as fields under its agent picker. */
export function AgentLaunchDefaultsFields({
  entry,
  draft,
  disabled,
  onCommit
}: {
  entry: AgentPickerEntry
  draft: AgentPickerDraft
  disabled?: boolean
  /** `surface` is set for Arguments, which a launch kept until its Use action named one. */
  onCommit: (draft: AgentPickerDraft, surface?: AgentPickerSurface) => void
}) {
  const t = useTranslate()
  const argumentsKnown = agentPickerArgumentsKnown(entry, draft)
  const argumentsView = agentPickerPanelArguments(entry, draft)
  const { currentModel } = agentLaunchSetupState(entry, draft, disabled)
  const defaultsPending =
    draft.surface === 'chat' ? entry.structuredDefaultsPending : entry.defaultsPending
  // As the picker did: edit the current draft, then accept what its Arguments now say.
  const edit = (base: AgentPickerDraft, change: AgentPickerEdit) =>
    currentAgentPickerDraft(
      entry,
      applyAgentPickerEdit(entry, currentAgentPickerDraft(entry, base), change)
    )
  const apply = (change: AgentPickerEdit, base = draft) =>
    acceptAgentPickerArguments(entry, edit(base, change))
  const note = agentLaunchArgumentsNote(
    entry.label,
    agentPickerEntryOptions(entry, currentModel, draft.surface),
    !getAgentSessionOptionLaunchCatalog(entry.agent)?.modelApply.cli?.length
  )
  const choiceChips = agentModelChoiceChips(
    entry.agent,
    entry.label,
    argumentsView.choices,
    (patch, text) => {
      // The chip edits the text in the field, typed but not yet saved, as the picker's field did.
      const typed =
        text === argumentsView.text
          ? draft
          : edit(draft, { kind: 'arguments', text, model: currentModel })
      const key =
        patch.model !== undefined
          ? 'model'
          : patch.permissionMode !== undefined
            ? 'permissionMode'
            : Object.keys(patch.options ?? {})[0]
      const next = apply({ kind: 'remove-chip', key }, typed)
      onCommit(next, next.surface)
      return agentPickerPanelArguments(entry, next).text
    },
    argumentsView.context
  )
  return (
    <div className="grid min-w-0 gap-2">
      <AgentPermissionMenu
        agentId={entry.agent}
        label={entry.label}
        layout="row"
        showInherited={false}
        rawValue={argumentsView.selectedPermission ? undefined : argumentsView.permission}
        disabled={
          disabled ||
          defaultsPending ||
          !argumentsView.permission ||
          (entry.surfaces.includes('terminal') && !argumentsKnown)
        }
        permission={{
          choice: argumentsView.selectedPermission ?? 'own',
          defaultChoice: argumentsView.selectedPermission ?? 'own',
          choices: agentPickerPermissions(entry.agent, draft.surface),
          source: 'agent',
          flag: '',
          argsSetPermission: false,
          onSelect: (choice) => {
            if (choice !== 'default') {
              onCommit(apply({ kind: 'permission', value: choice }))
            }
          }
        }}
      />
      {entry.surfaces.includes('terminal') ? (
        <div className="grid gap-1">
          <div className="flex min-h-7 items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">{t('agentPicker.arguments', 'Arguments')}</span>
            <span className="ml-auto truncate text-muted-foreground/70">
              {t('agentPicker.argumentsTerminalHint', 'Only applies to terminal (CLI) launches')}
            </span>
          </div>
          <AgentDefaultArgsInput
            hideLabel
            defaultArgs={argumentsView.text}
            argsOverride={argumentsView.text}
            disabled={disabled || !argumentsKnown}
            note={note}
            onSaveArgs={(text) => {
              const next = apply({ kind: 'arguments', text, model: currentModel })
              onCommit(next, next.surface)
            }}
            choiceChips={choiceChips}
          />
        </div>
      ) : null}
    </div>
  )
}
