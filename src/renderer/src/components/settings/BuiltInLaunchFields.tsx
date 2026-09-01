import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  MAX_AGENT_ARGS_CODE_UNITS,
  MAX_COMMAND_PATH_LENGTH
} from '../../../../shared/custom-tui-agent-fields'
import { REPO_PATH_PLACEHOLDER, WORKTREE_PATH_PLACEHOLDER } from './custom-agent-template-insert'
import { findFieldError } from './custom-agent-editor-copy'
import type { UseCustomAgentEditor } from './use-custom-agent-editor'

const TEXTAREA_CLASS =
  'min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30'

function VariableInsertChips({
  onInsert
}: {
  onInsert: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1">
      {[REPO_PATH_PLACEHOLDER, WORKTREE_PATH_PLACEHOLDER].map((placeholder) => (
        <Button
          key={placeholder}
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 font-mono text-[11px]"
          // Keep the field focused/selected so the insert lands at the caret.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onInsert(placeholder)}
        >
          {placeholder}
        </Button>
      ))}
    </div>
  )
}

function ResetButton({ onReset }: { onReset: () => void }): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
      onClick={onReset}
    >
      {translate('auto.components.settings.BuiltInLaunchSettingsDialog.reset', 'Reset')}
    </Button>
  )
}

/** Built-in command override: raw, permissive (multi-token wrappers allowed), with
 *  the stock command shown as the placeholder and a Reset that clears the override. */
export function BuiltInCommandField({
  editor,
  defaultCmd
}: {
  editor: UseCustomAgentEditor
  defaultCmd: string
}): React.JSX.Element {
  const error = findFieldError(editor.fieldErrors, 'commandOverride')
  const hasOverride = editor.draft.commandOverride.trim() !== ''
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="built-in-command">
          {translate(
            'auto.components.settings.BuiltInLaunchSettingsDialog.fieldLabelCommand',
            'Command'
          )}
        </Label>
        <div className="flex items-center gap-1">
          {hasOverride ? (
            <ResetButton onReset={() => editor.updateField({ commandOverride: '' })} />
          ) : null}
          <VariableInsertChips onInsert={editor.insertPlaceholder} />
        </div>
      </div>
      <Input
        id="built-in-command"
        value={editor.draft.commandOverride}
        spellCheck={false}
        maxLength={MAX_COMMAND_PATH_LENGTH}
        placeholder={defaultCmd}
        aria-invalid={error ? true : undefined}
        className="font-mono text-sm"
        onFocus={(event) =>
          editor.registerTemplateField({ kind: 'commandOverride' }, event.currentTarget)
        }
        onChange={(event) => {
          editor.updateField({ commandOverride: event.target.value })
          editor.clearFieldErrors('commandOverride')
        }}
      />
      {error ? <p className="text-xs font-medium text-destructive">{error.message}</p> : null}
    </div>
  )
}

/** Built-in arguments: legacy shell text (no v1 token preview), length-bounded, with
 *  variable chips and a Reset that clears the override back to the stock launch. */
export function BuiltInArgsField({ editor }: { editor: UseCustomAgentEditor }): React.JSX.Element {
  const error = findFieldError(editor.fieldErrors, 'args')
  const hasOverride = editor.draft.args !== ''
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="built-in-args">
          {translate(
            'auto.components.settings.CustomAgentEditorDialog.fieldLabelArguments',
            'Arguments'
          )}
        </Label>
        <div className="flex items-center gap-1">
          {hasOverride ? <ResetButton onReset={() => editor.updateField({ args: '' })} /> : null}
          <VariableInsertChips onInsert={editor.insertPlaceholder} />
        </div>
      </div>
      <textarea
        id="built-in-args"
        ref={editor.refs.argsTextareaRef}
        value={editor.draft.args}
        spellCheck={false}
        maxLength={MAX_AGENT_ARGS_CODE_UNITS}
        aria-invalid={error ? true : undefined}
        className={cn(TEXTAREA_CLASS)}
        placeholder={translate(
          'auto.components.settings.BuiltInLaunchSettingsDialog.argsPlaceholder',
          'No default arguments'
        )}
        onFocus={(event) => editor.registerTemplateField({ kind: 'args' }, event.currentTarget)}
        onChange={(event) => {
          editor.updateField({ args: event.target.value })
          editor.clearFieldErrors('args')
        }}
      />
      {error ? <p className="text-xs font-medium text-destructive">{error.message}</p> : null}
    </div>
  )
}
