import { useId, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SearchableSetting } from './SearchableSetting'
import { getTaskPromptTemplateSearchEntry } from './task-prompt-template-search'
import { useDebouncedSettingsTextDraft } from './use-debounced-settings-text-draft'

export function TaskPromptTemplateSetting({
  value,
  commit,
  scope,
  globalTemplate,
  forceVisible = false
}: {
  value: string
  commit: (next: string) => Promise<boolean>
  scope: 'global' | 'project'
  globalTemplate?: string
  forceVisible?: boolean
}): React.JSX.Element {
  const id = useId()
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [pendingDraft, setPendingDraft] = useState<string | null>(null)
  const saveTail = useRef(Promise.resolve())
  const editVersion = useRef(0)
  const save = (next: string): Promise<void> => {
    const version = editVersion.current
    saveTail.current = saveTail.current.then(async () => {
      try {
        const result = await commit(next)
        if (version === editVersion.current) {
          setSaveStatus(result ? 'saved' : 'error')
          if (result) {
            setPendingDraft(null)
          }
        }
      } catch {
        if (version === editVersion.current) {
          setSaveStatus('error')
        }
      }
    })
    return saveTail.current
  }
  const draft = useDebouncedSettingsTextDraft({ value: pendingDraft ?? value, commit: save })
  const edit = (next: string): void => {
    editVersion.current += 1
    setPendingDraft(next)
    setSaveStatus('idle')
    draft.onChange(next)
  }
  const entry = getTaskPromptTemplateSearchEntry()
  const inheritedTemplate = globalTemplate?.trim() ? globalTemplate : '{{url}}'

  return (
    <SearchableSetting {...entry} forceVisible={forceVisible} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={id}>{entry.title}</Label>
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {entry.description}
        </p>
      </div>
      <Textarea
        id={id}
        aria-describedby={`${id}-description ${id}-scope`}
        value={draft.value}
        onChange={(event) => edit(event.target.value)}
        onBlur={() => {
          if (saveStatus === 'error') {
            void save(draft.value)
          } else {
            draft.onBlur()
          }
        }}
        placeholder={inheritedTemplate}
        rows={4}
        spellCheck={false}
        variant="code"
      />
      <div className="flex items-start justify-between gap-3">
        <p id={`${id}-scope`} className="text-xs text-muted-foreground">
          {scope === 'project'
            ? translate(
                'components.TaskPromptTemplateSetting.projectHint',
                'Overrides the global prompt for this project. Leave blank to use Settings → Task Sources.'
              )
            : translate(
                'components.TaskPromptTemplateSetting.globalHint',
                'Applies to all task sources. Projects can override this prompt. Leave blank to keep the default draft.'
              )}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          disabled={!draft.value}
          onClick={() => {
            edit('')
            draft.onBlur()
          }}
        >
          {scope === 'project'
            ? translate('components.TaskPromptTemplateSetting.inherit', 'Use global prompt')
            : translate('components.TaskPromptTemplateSetting.reset', 'Reset to default')}
        </Button>
      </div>
      {saveStatus === 'error' ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'components.TaskPromptTemplateSetting.saveError',
            'Could not save the prompt. Edit it or leave the field again to retry.'
          )}
        </p>
      ) : saveStatus === 'saved' ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('components.TaskPromptTemplateSetting.saved', 'Saved')}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
