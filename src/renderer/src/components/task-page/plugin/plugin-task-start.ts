import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source'
import type { LinkedPluginTask } from '../../../../../shared/plugins/plugin-task-link'
import type { PluginTaskSourceRef } from '../../../../../shared/plugins/plugin-task-source-ref'
import { pluginTaskErrorMessage } from './plugin-task-error-message'
import { resolvePluginTaskProject, type PluginTaskProject } from './plugin-task-project'

export function buildLinkedPluginTask(
  item: PluginTaskItem,
  source: PluginTaskSourceRef & { title: string }
): LinkedPluginTask {
  return {
    pluginKey: source.pluginKey,
    sourceId: source.sourceId,
    itemId: item.id,
    title: item.title,
    sourceTitle: source.title,
    ...(item.url ? { url: item.url } : {}),
    ...(item.start?.linkMetadata ? { metadata: item.start.linkMetadata } : {})
  }
}

/** Opens Create workspace prefilled from the item's start recipe; the user reviews before creating. */
export async function openComposerForPluginTask(
  item: PluginTaskItem,
  source: PluginTaskSourceRef & { title: string }
): Promise<boolean> {
  const recipe = item.start
  if (!recipe) {
    return false
  }
  const { repos, activeRepoId } = useAppStore.getState()
  let project: PluginTaskProject
  try {
    project = await resolvePluginTaskProject(recipe, repos, activeRepoId)
  } catch (error) {
    // Why: callers fire and forget, so a failing matcher must not become an unhandled rejection.
    console.error('Failed to resolve the plugin task project:', error)
    toast.error(pluginTaskErrorMessage(error))
    return false
  }
  if (project.kind === 'missing') {
    toast.error(project.message)
    return false
  }
  useAppStore.getState().openModal('new-workspace-composer', {
    prefilledName: recipe.workspaceName ?? item.title,
    ...(project.kind === 'found' ? { initialRepoId: project.repoId } : {}),
    ...(recipe.baseRef ? { initialBaseBranch: recipe.baseRef } : {}),
    ...(recipe.agentPrompt ? { initialAgentDraft: recipe.agentPrompt } : {}),
    ...(recipe.sessionOptions ? { initialAgentSessionOptions: recipe.sessionOptions } : {}),
    linkedPluginTask: buildLinkedPluginTask(item, source),
    telemetrySource: 'sidebar'
  })
  return true
}
