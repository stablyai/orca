import { buildBranchNamePrompt } from '../../../../shared/branch-name-from-work'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { translate } from '@/i18n/i18n'

const BUILT_IN_BRANCH_NAME_PROMPT = buildBranchNamePrompt({
  firstPrompt: '{first agent prompt}',
  assistantMessage: '{agent initial response, when available}'
})

type AutoRenameBranchPromptEditorProps = {
  draft: string
  dirty: boolean
  saving: boolean
  onDraftChange: (value: string) => void
  onDiscard: () => void
  onSave: () => void | Promise<void>
}

export function AutoRenameBranchPromptEditor({
  draft,
  dirty,
  saving,
  onDraftChange,
  onDiscard,
  onSave
}: AutoRenameBranchPromptEditorProps): React.JSX.Element {
  return (
    // Why: py-2 matches the sibling rows so the editor doesn't hug the group's
    // divide-y divider the way the model/prompt rows are spaced.
    <div className="space-y-2 py-2">
      <div className="space-y-0.5">
        <Label htmlFor="git-auto-rename-branch-name-prompt">
          {translate('auto.components.settings.AutoRenameBranchPromptEditor.7d6176f506', 'Prompt')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AutoRenameBranchPromptEditor.2f5dc661fe',
            "Appended to Orca's"
          )}{' '}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {translate(
                  'auto.components.settings.AutoRenameBranchPromptEditor.182d419b97',
                  'built-in branch-name prompt'
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              side="bottom"
              className="w-[520px] max-w-[calc(100vw-2rem)] p-3"
            >
              <div>
                <pre className="scrollbar-sleek max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {BUILT_IN_BRANCH_NAME_PROMPT}
                </pre>
              </div>
            </PopoverContent>
          </Popover>
          {translate(
            'auto.components.settings.AutoRenameBranchPromptEditor.af2d9a2cc6',
            '. Orca generates only the final segment, like'
          )}{' '}
          <code className="font-mono">
            {translate(
              'auto.components.settings.AutoRenameBranchPromptEditor.ebb942a2ec',
              'fix-login-flow'
            )}
          </code>
          {translate(
            'auto.components.settings.AutoRenameBranchPromptEditor.39278f4411',
            '; your branch prefix setting still applies.'
          )}
        </p>
      </div>
      <textarea
        id="git-auto-rename-branch-name-prompt"
        rows={4}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder={translate(
          'auto.components.settings.AutoRenameBranchPromptEditor.4416b25d29',
          'Prefer domain nouns from the task, avoid ticket IDs, and keep names reviewer-friendly.'
        )}
        className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          {dirty
            ? translate(
                'auto.components.settings.AutoRenameBranchPromptEditor.0691753cf2',
                'Unsaved changes'
              )
            : translate(
                'auto.components.settings.AutoRenameBranchPromptEditor.af0831a590',
                'Saved'
              )}
        </p>
        <div className="flex items-center gap-2">
          {dirty ? (
            <Button type="button" variant="ghost" size="xs" onClick={onDiscard} disabled={saving}>
              {translate(
                'auto.components.settings.AutoRenameBranchPromptEditor.63121132c0',
                'Discard'
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => void onSave()}
            disabled={!dirty || saving}
          >
            {saving
              ? translate(
                  'auto.components.settings.AutoRenameBranchPromptEditor.54ac229ad4',
                  'Saving...'
                )
              : translate(
                  'auto.components.settings.AutoRenameBranchPromptEditor.5968112152',
                  'Save'
                )}
          </Button>
        </div>
      </div>
    </div>
  )
}
