import { Eye, EyeOff, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  MAX_CUSTOM_AGENT_ENV_BYTES,
  MAX_CUSTOM_AGENT_ENV_ENTRIES
} from '../../../../shared/custom-tui-agent-fields'
import { createEnvRow, type CustomAgentEnvRow } from './custom-agent-editor-state'
import { findFieldError } from './custom-agent-editor-copy'
import { baseAgentUsesManagedAccount } from '../../../../shared/managed-account-base-agents'
import type { UseCustomAgentEditor } from './use-custom-agent-editor'

/** Key/value environment editor: values are masked with a per-row reveal, the
 *  aggregate size meter never renders a key or value, and "Add variable" is
 *  capped at 64 rows. Per-row errors map to the validator's serialized index
 *  (fully-blank rows are dropped before validation, so they never carry one). */
export function CustomAgentEnvRowsEditor({
  editor
}: {
  editor: UseCustomAgentEditor
}): React.JSX.Element {
  const rows = editor.draft.envRows
  const atCap = rows.length >= MAX_CUSTOM_AGENT_ENV_ENTRIES
  const sectionError = findFieldError(editor.fieldErrors, 'env', undefined)

  let serializedIndex = 0

  return (
    <div id="custom-agent-env-section" tabIndex={-1} className="space-y-2 outline-none">
      <div className="flex items-center justify-between">
        <Label>
          {translate(
            'auto.components.settings.CustomAgentEditorDialog.fieldLabelEnv',
            'Environment variables'
          )}
        </Label>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {translate(
            'auto.components.settings.CustomAgentEditorDialog.envSizeMeter',
            '{{bytes}} of {{max}} bytes',
            { bytes: editor.envSizeBytes, max: MAX_CUSTOM_AGENT_ENV_BYTES }
          )}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.CustomAgentEditorDialog.envPrecedenceHint',
          "Variables set here override the base harness's default environment."
        )}
      </p>

      {/* Only Codex/Claude bases inject a selected managed account, so an
          explicit auth/home row here overrides it — surface that precedence
          only for those bases, never for a harness with no managed account. */}
      {baseAgentUsesManagedAccount(editor.baseAgent) ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CustomAgentEditorDialog.envManagedAccountHint',
            "Explicit provider auth or home values here (including CODEX_HOME) override the selected managed account for this agent's launches. Orca still sets up the base harness's required companion and hook state."
          )}
        </p>
      ) : null}

      <div className="space-y-2">
        {rows.map((row) => {
          const isBlank = row.key === '' && row.value === ''
          const rowSerializedIndex = isBlank ? undefined : serializedIndex
          if (!isBlank) {
            serializedIndex += 1
          }
          const rowError =
            rowSerializedIndex === undefined
              ? undefined
              : findFieldError(editor.fieldErrors, 'env', rowSerializedIndex)
          return (
            <EnvRowFields
              key={row.rowId}
              row={row}
              disabled={editor.inputsLocked}
              error={rowError?.message}
              onKeyChange={(key) =>
                editor.setEnvRows((current) =>
                  current.map((r) => (r.rowId === row.rowId ? { ...r, key } : r))
                )
              }
              onValueChange={(value) =>
                editor.setEnvRows((current) =>
                  current.map((r) => (r.rowId === row.rowId ? { ...r, value } : r))
                )
              }
              onToggleReveal={() =>
                editor.setEnvRows((current) =>
                  current.map((r) => (r.rowId === row.rowId ? { ...r, revealed: !r.revealed } : r))
                )
              }
              onValueFocus={(element) =>
                editor.registerTemplateField({ kind: 'env', rowId: row.rowId }, element)
              }
              onRemove={() =>
                editor.setEnvRows((current) => {
                  const next = current.filter((r) => r.rowId !== row.rowId)
                  return next.length > 0 ? next : [createEnvRow()]
                })
              }
            />
          )
        })}
      </div>

      {sectionError ? (
        <p className="text-xs font-medium text-destructive">{sectionError.message}</p>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={atCap || editor.inputsLocked}
        onClick={() => editor.setEnvRows((current) => [...current, createEnvRow()])}
      >
        <Plus className="size-3.5" />
        {translate('auto.components.settings.CustomAgentEditorDialog.envAdd', 'Add variable')}
      </Button>
      {atCap ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CustomAgentEditorDialog.envAtCap',
            'You can add up to 64 variables and 16 KiB total.'
          )}
        </p>
      ) : null}
    </div>
  )
}

type EnvRowFieldsProps = {
  row: CustomAgentEnvRow
  disabled?: boolean
  error?: string
  onKeyChange: (key: string) => void
  onValueChange: (value: string) => void
  onToggleReveal: () => void
  onValueFocus: (element: HTMLInputElement) => void
  onRemove: () => void
}

function EnvRowFields({
  row,
  disabled,
  error,
  onKeyChange,
  onValueChange,
  onToggleReveal,
  onValueFocus,
  onRemove
}: EnvRowFieldsProps): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          value={row.key}
          disabled={disabled}
          placeholder={translate(
            'auto.components.settings.CustomAgentEditorDialog.envKeyPlaceholder',
            'NAME'
          )}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-label={translate(
            'auto.components.settings.CustomAgentEditorDialog.envKeyAriaLabel',
            'Variable name'
          )}
          className="font-mono"
          onChange={(event) => onKeyChange(event.target.value)}
        />
        <Input
          value={row.value}
          disabled={disabled}
          type={row.revealed ? 'text' : 'password'}
          placeholder={translate(
            'auto.components.settings.CustomAgentEditorDialog.envValuePlaceholder',
            'value'
          )}
          autoComplete="off"
          spellCheck={false}
          aria-label={translate(
            'auto.components.settings.CustomAgentEditorDialog.envValueAriaLabel',
            'Variable value'
          )}
          className="font-mono"
          onFocus={(event) => onValueFocus(event.currentTarget)}
          onChange={(event) => onValueChange(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          onClick={onToggleReveal}
          aria-pressed={row.revealed}
          aria-label={
            row.revealed
              ? translate('auto.components.settings.CustomAgentEditorDialog.envHide', 'Hide value')
              : translate(
                  'auto.components.settings.CustomAgentEditorDialog.envReveal',
                  'Reveal value'
                )
          }
        >
          {row.revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          onClick={onRemove}
          aria-label={translate(
            'auto.components.settings.CustomAgentEditorDialog.envRemove',
            'Remove variable'
          )}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  )
}
