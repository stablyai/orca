import { useId } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CloudApiInstallation,
  CloudApiProject
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { FormField } from './cloud-api-parts'
import { routineFieldError } from './RoutineAgentSection'
import { GithubAppHint } from './RoutineWebhookParts'
import type { RoutineDraft, RoutineDraftField } from './routine-draft'

/** "Where it runs": an Orca Cloud project, or a repository URL and branch. */
export function RoutineSourceSection({
  draft,
  update,
  errors,
  projects,
  projectOptions,
  projectsFailed,
  installations
}: {
  draft: RoutineDraft
  update: (patch: Partial<RoutineDraft>) => void
  errors: Partial<Record<RoutineDraftField, string>>
  projects: readonly CloudApiProject[]
  projectOptions: readonly CloudApiProject[]
  projectsFailed: boolean
  installations: readonly CloudApiInstallation[] | null
}): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  const err = (field: RoutineDraftField): string | null =>
    routineFieldError(errors[field], field, t)
  return (
    <section className="grid gap-3" aria-labelledby={`${ids}-where`}>
      <h3 id={`${ids}-where`} className="text-sm font-semibold">
        {t('auto.components.settings.cloudRoutines.editor.where', 'Where it runs')}
      </h3>
      <div>
        <SettingsSegmentedControl<'project' | 'repo'>
          size="sm"
          equalWidth
          value={draft.source}
          onChange={(source) => update({ source })}
          ariaLabelledBy={`${ids}-where`}
          options={[
            {
              value: 'project',
              label: t('auto.components.settings.cloudRoutines.editor.project', 'Project')
            },
            {
              value: 'repo',
              label: t('auto.components.settings.cloudRoutines.editor.repo', 'Repository URL')
            }
          ]}
        />
      </div>
      {draft.source === 'project' ? (
        <FormField
          id={`${ids}-project`}
          label={t('auto.components.settings.cloudRoutines.editor.projectLabel', 'Project')}
          error={err('source')}
          hint={
            projectsFailed
              ? t(
                  'auto.components.settings.cloudRoutines.editor.projectsFailed',
                  'Could not load your projects. Close and reopen to try again, or use a repository URL.'
                )
              : projects.length === 0
                ? t(
                    'auto.components.settings.cloudRoutines.editor.noProjects',
                    'No Orca Cloud projects yet. Use a repository URL instead.'
                  )
                : undefined
          }
        >
          <Select
            value={draft.projectId}
            onValueChange={(projectId) => update({ projectId })}
            disabled={projectOptions.length === 0}
          >
            <SelectTrigger
              id={`${ids}-project`}
              className="w-full"
              aria-invalid={Boolean(errors.source)}
              aria-describedby={
                errors.source
                  ? `${ids}-project-error`
                  : projectsFailed || projects.length === 0
                    ? `${ids}-project-hint`
                    : undefined
              }
            >
              <SelectValue
                placeholder={t(
                  'auto.components.settings.cloudRoutines.editor.pickProject',
                  'Choose a project'
                )}
              />
            </SelectTrigger>
            <SelectContent position="popper">
              {projectOptions.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                  {project.repo ? (
                    <span className="ml-1.5 text-muted-foreground">
                      {project.repo.url.replace(/^https:\/\/(www\.)?/, '')}
                    </span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <FormField
            id={`${ids}-repo`}
            label={t('auto.components.settings.cloudRoutines.editor.repoLabel', 'Repository')}
            error={err('repoUrl')}
          >
            <Input
              id={`${ids}-repo`}
              value={draft.repoUrl}
              inputMode="url"
              spellCheck={false}
              placeholder={t(
                'auto.components.settings.cloudRoutines.editor.repoUrlPlaceholder',
                'https://github.com/acme/api'
              )}
              aria-invalid={Boolean(errors.repoUrl)}
              aria-describedby={errors.repoUrl ? `${ids}-repo-error` : undefined}
              onChange={(event) => update({ repoUrl: event.target.value })}
            />
          </FormField>
          <FormField
            id={`${ids}-ref`}
            label={t('auto.components.settings.cloudRoutines.editor.ref', 'Branch')}
          >
            <Input
              id={`${ids}-ref`}
              value={draft.repoRef}
              spellCheck={false}
              placeholder={t(
                'auto.components.settings.cloudRoutines.editor.refPlaceholder',
                'default'
              )}
              onChange={(event) => update({ repoRef: event.target.value })}
            />
          </FormField>
        </div>
      )}
      <GithubAppHint installations={installations} />
    </section>
  )
}
