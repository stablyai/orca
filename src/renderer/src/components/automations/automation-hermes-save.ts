import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildHermesCronSchedule } from './automation-draft-model'
import { externalAutomationJobKey } from './external-automation-scope-keys'
import type { AutomationSaveContext } from './automation-save-context'

export async function saveHermesAutomation({
  store,
  local,
  list,
  pageRefresh
}: AutomationSaveContext): Promise<void> {
  const { repoMap, worktreeMap } = store
  const {
    draft,
    editingExternalTarget,
    setCreateOpen,
    setEditingExternalTarget,
    selectExternalKey
  } = local
  const repo = repoMap.get(draft.projectId)
  const selectedWorktree = worktreeMap.get(draft.workspaceId) ?? null
  if (!repo || !selectedWorktree) {
    toast.error(
      translate(
        'auto.components.automations.AutomationsPage.32534e7c9c',
        'Choose an available workspace before saving.'
      )
    )
    return
  }
  const scopedExternal = list.scopedExternal
  const scope =
    editingExternalTarget?.scope ?? scopedExternal.createScope(repo.connectionId ?? null)
  const repoTargetMatches = scope
    ? scope.owner.selector.kind === 'ssh'
      ? repo.connectionId === scope.owner.selector.targetId
      : !repo.connectionId
    : false
  if (!scope || !repoTargetMatches) {
    toast.error(
      translate(
        'auto.components.automations.AutomationsPage.e431bb85d4',
        'Choose a workspace on the same host as this Hermes automation.'
      )
    )
    return
  }
  const schedule = buildHermesCronSchedule(draft)
  const fields = {
    name: draft.name,
    prompt: draft.prompt,
    schedule,
    workdir: selectedWorktree.path
  }
  await scopedExternal.saveExternalAutomation(
    scope,
    {
      name: fields.name,
      prompt: fields.prompt,
      schedule: fields.schedule,
      workdir: fields.workdir
    },
    editingExternalTarget?.job.id ?? null
  )
  if (!editingExternalTarget) {
    useAppStore.getState().recordFeatureInteraction('automation-created')
  }
  await pageRefresh.refresh()
  setCreateOpen(false)
  setEditingExternalTarget(null)
  selectExternalKey(
    editingExternalTarget
      ? externalAutomationJobKey(editingExternalTarget.scope, editingExternalTarget.job.id)
      : null
  )
  toast.success(
    editingExternalTarget
      ? translate(
          'auto.components.automations.AutomationsPage.08efc3ae12',
          'Hermes automation updated.'
        )
      : translate(
          'auto.components.automations.AutomationsPage.77b81bc4ac',
          'Hermes automation created.'
        )
  )
}
