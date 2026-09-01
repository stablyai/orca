import type { KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { MAX_AGENT_LABEL_CODE_UNITS } from '../../../../shared/custom-tui-agent-fields'
import { translate } from '@/i18n/i18n'
import { CustomAgentBaseCombobox } from './CustomAgentBaseCombobox'
import { CustomAgentEditorFieldRow } from './CustomAgentEditorFieldRow'
import { findFieldError } from './custom-agent-editor-copy'
import { isBaseSelectableMode, type CustomAgentEditorMode } from './custom-agent-editor-state'
import type { UseCustomAgentEditor } from './use-custom-agent-editor'

type CustomAgentIdentityFieldsProps = {
  editor: UseCustomAgentEditor
  mode: CustomAgentEditorMode
  baseAgentOptions: readonly AgentCatalogEntry[]
  baseLabel: string
}

/** Name, base harness, and executable override — the identity block of the editor.
 *  Enter in these single-line fields submits (the multiline Arguments field does
 *  not); the base harness is a combobox on create and a read-only tile otherwise. */
export function CustomAgentIdentityFields({
  editor,
  mode,
  baseAgentOptions,
  baseLabel
}: CustomAgentIdentityFieldsProps): React.JSX.Element {
  const { draft, fieldErrors } = editor
  const labelError = findFieldError(fieldErrors, 'label')
  const commandError = findFieldError(fieldErrors, 'commandOverride')
  const baseSelectable = isBaseSelectableMode(mode)

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault()
      void editor.submit()
    }
  }

  return (
    <>
      <CustomAgentEditorFieldRow
        label={translate('auto.components.settings.CustomAgentEditorDialog.fieldLabelName', 'Name')}
        htmlFor="custom-agent-name"
        error={labelError}
        errorId="custom-agent-name-error"
      >
        <Input
          id="custom-agent-name"
          ref={editor.refs.nameInputRef}
          disabled={editor.inputsLocked}
          value={draft.label}
          maxLength={MAX_AGENT_LABEL_CODE_UNITS}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={labelError ? true : undefined}
          aria-describedby={labelError ? 'custom-agent-name-error' : undefined}
          onChange={(event) => {
            editor.updateField({ label: event.target.value })
            editor.clearFieldErrors('label')
          }}
          onKeyDown={submitOnEnter}
        />
      </CustomAgentEditorFieldRow>

      <CustomAgentEditorFieldRow
        label={translate(
          'auto.components.settings.CustomAgentEditorDialog.fieldLabelBase',
          'Base harness'
        )}
        htmlFor={baseSelectable ? 'custom-agent-base' : undefined}
        description={
          baseSelectable
            ? undefined
            : translate(
                'auto.components.settings.CustomAgentEditorDialog.baseImmutable',
                "The base harness can't change after creation. Create another agent to use a different harness."
              )
        }
      >
        {baseSelectable ? (
          <CustomAgentBaseCombobox
            id="custom-agent-base"
            options={baseAgentOptions}
            value={editor.baseAgent}
            onChange={(base) => editor.updateField({ baseAgent: base })}
          />
        ) : (
          <div
            className="flex h-9 items-center gap-2 rounded-md border border-input bg-muted/40 px-3 text-sm"
            aria-label={translate(
              'auto.components.settings.CustomAgentEditorDialog.baseReadOnlyLabel',
              'Base harness (read-only)'
            )}
          >
            <AgentIcon agent={editor.baseAgent} />
            <span className="truncate">{baseLabel}</span>
          </div>
        )}
      </CustomAgentEditorFieldRow>

      {mode.kind === 'duplicate' ? null : (
        <CustomAgentEditorFieldRow
          label={translate(
            'auto.components.settings.CustomAgentEditorDialog.fieldLabelExecutable',
            'Executable'
          )}
          htmlFor="custom-agent-executable"
          description={translate(
            'auto.components.settings.CustomAgentEditorDialog.executableHelp',
            'Optional path to one executable. Command lists and pipelines belong in Quick Commands.'
          )}
          error={commandError}
          errorId="custom-agent-executable-error"
        >
          <Input
            id="custom-agent-executable"
            disabled={editor.inputsLocked}
            value={draft.commandOverride}
            placeholder={translate(
              'auto.components.settings.CustomAgentEditorDialog.executablePlaceholder',
              '/usr/local/bin/my-agent'
            )}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={commandError ? true : undefined}
            aria-describedby={commandError ? 'custom-agent-executable-error' : undefined}
            onFocus={(event) =>
              editor.registerTemplateField({ kind: 'commandOverride' }, event.currentTarget)
            }
            onChange={(event) => {
              editor.updateField({ commandOverride: event.target.value })
              editor.clearFieldErrors('commandOverride')
            }}
            onKeyDown={submitOnEnter}
          />
        </CustomAgentEditorFieldRow>
      )}
    </>
  )
}
