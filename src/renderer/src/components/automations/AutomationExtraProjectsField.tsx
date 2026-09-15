import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from './automation-page-parts'
import AutomationProjectCombobox from './AutomationProjectCombobox'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationExtraProjectsFieldProps = {
  repos: readonly Repo[]
  draft: AutomationDraft
  pickerTriggerClassName: string
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

/** Extra projects that each get their own copy of the automation on create. */
export function AutomationExtraProjectsField({
  repos,
  draft,
  pickerTriggerClassName,
  getRepoHostLabel,
  onDraftChange
}: AutomationExtraProjectsFieldProps): React.JSX.Element | null {
  const chosen = new Set([draft.projectId, ...draft.extraProjectIds])
  const candidates = repos.filter((repo) => !chosen.has(repo.id))
  const extras = draft.extraProjectIds
    .map((id) => repos.find((repo) => repo.id === id))
    .filter((repo): repo is Repo => repo !== undefined)
  if (!draft.projectId || (candidates.length === 0 && extras.length === 0)) {
    return null
  }
  return (
    <Field
      className="mb-4"
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
      label={translate(
        'auto.components.automations.AutomationExtraProjectsField.label',
        'Also create in'
      )}
    >
      {extras.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {extras.map((repo) => (
            <Badge key={repo.id} variant="outline">
              <RepoBadgeLabel
                name={repo.displayName}
                color={repo.badgeColor}
                badgeClassName="size-1.5"
              />
              <button
                type="button"
                aria-label={translate(
                  'auto.components.automations.AutomationExtraProjectsField.remove',
                  'Remove {project}'
                ).replace('{project}', () => repo.displayName)}
                className="rounded-full text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onDraftChange((current) => ({
                    ...current,
                    extraProjectIds: current.extraProjectIds.filter((id) => id !== repo.id)
                  }))
                }
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      {candidates.length > 0 ? (
        <AutomationProjectCombobox
          repos={candidates}
          value=""
          placeholder={translate(
            'auto.components.automations.AutomationExtraProjectsField.add',
            'Add another project'
          )}
          triggerClassName={`h-9 w-full min-w-0 ${pickerTriggerClassName}`}
          getRepoHostLabel={getRepoHostLabel}
          allowAddProject={false}
          // Why: a workspace belongs to one project, so copies can only run in a fresh workspace.
          onValueChange={(repoId) =>
            onDraftChange((current) => ({
              ...current,
              extraProjectIds: [...current.extraProjectIds, repoId],
              workspaceMode: 'new_per_run',
              workspaceId: '',
              reuseSession: false
            }))
          }
        />
      ) : null}
      {extras.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.automations.AutomationExtraProjectsField.hint',
            'Saves one automation per project, each running in a new workspace.'
          )}
        </p>
      ) : null}
    </Field>
  )
}
