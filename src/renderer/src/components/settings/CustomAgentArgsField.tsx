import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { MAX_AGENT_ARGS_CODE_UNITS } from '../../../../shared/custom-tui-agent-fields'
import { REPO_PATH_PLACEHOLDER, WORKTREE_PATH_PLACEHOLDER } from './custom-agent-template-insert'
import { describeAgentFieldIssue, findFieldError } from './custom-agent-editor-copy'
import type { UseCustomAgentEditor } from './use-custom-agent-editor'

const TEXTAREA_CLASS =
  'min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30'

const TOKEN_PREVIEW_MAX_CHARS = 60

/** The multiline Arguments field: Enter inserts a newline (never submits), the
 *  shared tokenizer drives a live parsed-argument count/preview, and the
 *  {repoPath}/{worktreePath} chips splice a hint into the focused template field. */
export function CustomAgentArgsField({
  editor
}: {
  editor: UseCustomAgentEditor
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const { draft, tokenizeResult } = editor
  const submitError = findFieldError(editor.fieldErrors, 'args')
  const liveError = tokenizeResult.ok
    ? null
    : describeAgentFieldIssue({ field: 'args', reason: tokenizeResult.reason })

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="custom-agent-args">
          {translate(
            'auto.components.settings.CustomAgentEditorDialog.fieldLabelArguments',
            'Arguments'
          )}
        </Label>
        <div className="flex items-center gap-1">
          <InsertChip
            label={REPO_PATH_PLACEHOLDER}
            disabled={editor.inputsLocked}
            onInsert={() => editor.insertPlaceholder(REPO_PATH_PLACEHOLDER)}
          />
          <InsertChip
            label={WORKTREE_PATH_PLACEHOLDER}
            disabled={editor.inputsLocked}
            onInsert={() => editor.insertPlaceholder(WORKTREE_PATH_PLACEHOLDER)}
          />
        </div>
      </div>
      <textarea
        id="custom-agent-args"
        ref={editor.refs.argsTextareaRef}
        disabled={editor.inputsLocked}
        value={draft.args}
        spellCheck={false}
        maxLength={MAX_AGENT_ARGS_CODE_UNITS}
        aria-invalid={submitError || liveError ? true : undefined}
        aria-describedby="custom-agent-args-preview"
        className={cn(TEXTAREA_CLASS)}
        placeholder={translate(
          'auto.components.settings.CustomAgentEditorDialog.argsPlaceholder',
          '--model gpt-5\n--flag value'
        )}
        onFocus={(event) => editor.registerTemplateField({ kind: 'args' }, event.currentTarget)}
        onChange={(event) => {
          editor.updateField({ args: event.target.value })
          editor.clearFieldErrors('args')
        }}
      />
      <div id="custom-agent-args-preview" className="space-y-1">
        {liveError ? (
          <p className="text-xs font-medium text-destructive">{liveError.message}</p>
        ) : (
          <ArgsTokenPreview
            tokens={tokenizeResult.ok ? tokenizeResult.tokens : []}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        )}
        {submitError && !liveError ? (
          <p className="text-xs font-medium text-destructive">{submitError.message}</p>
        ) : null}
      </div>
    </div>
  )
}

function InsertChip({
  label,
  disabled,
  onInsert
}: {
  label: string
  disabled?: boolean
  onInsert: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      className="h-6 px-2 font-mono text-[11px]"
      // Keep the target field focused and its selection intact so the insert
      // lands at the caret instead of the end.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onInsert}
    >
      {label}
    </Button>
  )
}

function ArgsTokenPreview({
  tokens,
  expanded,
  onToggle
}: {
  tokens: readonly string[]
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const count = tokens.length
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        className="underline-offset-2 hover:underline"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {translate(
          'auto.components.settings.CustomAgentEditorDialog.argsTokenCount',
          '{{count}} arguments',
          { count }
        )}
      </button>
      {expanded && count > 0 ? (
        <ol className="mt-1 list-decimal space-y-0.5 pl-5 font-mono">
          {tokens.map((token, index) => (
            <li key={index} className="break-all">
              {token.length > TOKEN_PREVIEW_MAX_CHARS
                ? `${token.slice(0, TOKEN_PREVIEW_MAX_CHARS)}…`
                : token || '""'}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
