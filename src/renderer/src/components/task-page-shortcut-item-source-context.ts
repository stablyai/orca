import type { ShortcutStory, ShortcutWorkspace } from '../../../shared/shortcut-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export function bindTaskPageShortcutItemSourceContext(args: {
  story: ShortcutStory
  workspaces: readonly ShortcutWorkspace[]
  sourceContext: TaskSourceContext | null
}): TaskSourceContext | null {
  if (args.sourceContext?.provider !== 'shortcut' || !args.story.workspaceId) {
    return null
  }
  const workspace = args.workspaces.find((candidate) => candidate.id === args.story.workspaceId)
  if (!workspace) {
    return null
  }
  return normalizeTaskSourceContext({
    ...args.sourceContext,
    providerIdentity: {
      provider: 'shortcut',
      workspaceId: workspace.id,
      workspaceSlug: workspace.urlSlug,
      teamId: args.story.team?.id ?? null
    },
    accountLabel: workspace.name || workspace.urlSlug
  })
}
