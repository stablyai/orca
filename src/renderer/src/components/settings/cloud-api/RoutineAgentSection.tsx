import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { FormField } from './cloud-api-parts'
import type { RoutineDraft, RoutineDraftField } from './routine-draft'

export function routineFieldError(
  code: string | undefined,
  field: RoutineDraftField,
  t: Translate = translate
): string | null {
  if (!code) {
    return null
  }
  switch (field) {
    case 'name':
      return t(
        'auto.components.settings.cloudRoutines.editor.nameRequired',
        'Give the routine a name.'
      )
    case 'source':
      return t('auto.components.settings.cloudRoutines.editor.projectRequired', 'Pick a project.')
    case 'repoUrl':
      return code === 'required'
        ? t(
            'auto.components.settings.cloudRoutines.editor.repoRequired',
            'Enter the repository URL.'
          )
        : t(
            'auto.components.settings.cloudRoutines.editor.repoInvalid',
            'Use an https URL, like https://github.com/acme/api.'
          )
    case 'customCron':
      return code === 'required'
        ? t(
            'auto.components.settings.cloudRoutines.editor.cronRequired',
            'Enter a five-field cron.'
          )
        : t(
            'auto.components.settings.cloudRoutines.editor.cronInvalid',
            'That cron expression is not valid.'
          )
    case 'githubEvents':
      return t(
        'auto.components.settings.cloudRoutines.editor.eventsRequired',
        'Pick at least one event.'
      )
    case 'prompt':
      return t(
        'auto.components.settings.cloudRoutines.editor.promptRequired',
        'Tell the agent what to do.'
      )
    case 'maxRuntimeMinutes':
      return t(
        'auto.components.settings.cloudRoutines.editor.runtimeInvalid',
        'Use a whole number from 1 to 720.'
      )
  }
}

/** Agent, prompt, what happens with the result, and the time limit. */
export function RoutineAgentSection({
  draft,
  update,
  errors
}: {
  draft: RoutineDraft
  update: (patch: Partial<RoutineDraft>) => void
  errors: Partial<Record<RoutineDraftField, string>>
}): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  const err = (field: RoutineDraftField): string | null =>
    routineFieldError(errors[field], field, t)
  return (
    <section className="grid gap-3" aria-labelledby={`${ids}-what`}>
      <h3 id={`${ids}-what`} className="text-sm font-semibold">
        {t('auto.components.settings.cloudRoutines.editor.what', 'What the agent does')}
      </h3>
      <div className="grid gap-1.5">
        <p id={`${ids}-agent`} className="text-xs font-medium">
          {t('auto.components.settings.cloudRoutines.editor.agent', 'Agent')}
        </p>
        <SettingsSegmentedControl<'claude' | 'codex'>
          size="sm"
          value={draft.agent}
          onChange={(agent) => update({ agent })}
          equalWidth
          ariaLabelledBy={`${ids}-agent`}
          options={[
            { value: 'claude', label: 'Claude Code' },
            { value: 'codex', label: 'Codex' }
          ]}
        />
      </div>
      <FormField
        id={`${ids}-prompt`}
        label={t('auto.components.settings.cloudRoutines.editor.prompt', 'Prompt')}
        error={err('prompt')}
      >
        <Textarea
          id={`${ids}-prompt`}
          rows={5}
          value={draft.prompt}
          placeholder={t(
            'auto.components.settings.cloudRoutines.editor.promptPlaceholder',
            'Review the pull request for bugs and missing tests. Keep feedback short and specific.'
          )}
          aria-invalid={Boolean(errors.prompt)}
          aria-describedby={errors.prompt ? `${ids}-prompt-error` : undefined}
          onChange={(event) => update({ prompt: event.target.value })}
        />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <div className="grid gap-1.5">
          <p id={`${ids}-post`} className="text-xs font-medium">
            {t('auto.components.settings.cloudRoutines.editor.post', 'When it finishes')}
          </p>
          <SettingsSegmentedControl<RoutineDraft['postResults']>
            size="sm"
            equalWidth
            value={draft.postResults}
            onChange={(postResults) => update({ postResults })}
            ariaLabelledBy={`${ids}-post`}
            options={[
              {
                value: 'none',
                label: t('auto.components.settings.cloudRoutines.editor.postNone', 'Do nothing')
              },
              {
                value: 'comment',
                label: t('auto.components.settings.cloudRoutines.editor.postComment', 'Comment')
              },
              {
                value: 'pr',
                label: t('auto.components.settings.cloudRoutines.editor.postPr', 'Open a PR')
              }
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {draft.postResults === 'comment'
              ? t(
                  'auto.components.settings.cloudRoutines.editor.postCommentHint',
                  'Posts a summary on the PR or issue that triggered it.'
                )
              : draft.postResults === 'pr'
                ? t(
                    'auto.components.settings.cloudRoutines.editor.postPrHint',
                    'Pushes the agent’s changes to a branch and opens a pull request.'
                  )
                : t(
                    'auto.components.settings.cloudRoutines.editor.postNoneHint',
                    'Results stay in the run history and the workspace.'
                  )}
          </p>
        </div>
        <FormField
          id={`${ids}-runtime`}
          label={t('auto.components.settings.cloudRoutines.editor.runtime', 'Time limit (min)')}
          error={err('maxRuntimeMinutes')}
        >
          <Input
            id={`${ids}-runtime`}
            inputMode="numeric"
            value={draft.maxRuntimeMinutes}
            aria-invalid={Boolean(errors.maxRuntimeMinutes)}
            aria-describedby={errors.maxRuntimeMinutes ? `${ids}-runtime-error` : undefined}
            onChange={(event) =>
              update({ maxRuntimeMinutes: event.target.value.replace(/[^0-9]/g, '') })
            }
          />
        </FormField>
      </div>
    </section>
  )
}
