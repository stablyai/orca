import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveWorkItemStartPromptDelivery } from '../../../../shared/work-item-start-prompt-delivery'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { prepareQuickWorkItemStartRoute } from '@/hooks/composer-state/quick-work-item-start-route'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import {
  hasExplicitTuiAgentArgs,
  hasExplicitTuiLaunchCustomization
} from '@/lib/agent-launch-routing'
import { resolveFolderWorkspaceLaunchDraft } from './folder-workspace-agent-startup'

export async function prepareFolderWorkspaceWorkItemStart(args: {
  projectGroup: ProjectGroup
  linkedWorkItem: LinkedWorkItemSummary | null
  note: string
  agent: TuiAgent | null
  agentArgs?: string | null
  settings?: GlobalSettings | null
  runtimeEnvironmentId?: string | null
  initialSessionOptions?: Readonly<Record<string, unknown>>
}) {
  const promptDelivery = args.linkedWorkItem
    ? resolveWorkItemStartPromptDelivery(args.settings?.workItemStartPromptDelivery)
    : undefined
  const launchText =
    args.agent && args.linkedWorkItem
      ? resolveFolderWorkspaceLaunchDraft(args.linkedWorkItem, args.note, promptDelivery)
      : null
  const executionHostId = args.runtimeEnvironmentId
    ? `runtime:${encodeURIComponent(args.runtimeEnvironmentId)}`
    : args.projectGroup.connectionId
      ? `ssh:${encodeURIComponent(args.projectGroup.connectionId)}`
      : promptDelivery === 'submit-after-ready' && isWslUncPath(args.projectGroup.parentPath ?? '')
        ? 'wsl:local'
        : 'local'
  const resolution = await prepareQuickWorkItemStartRoute({
    agent: args.agent,
    hasLinkedWorkItem: args.linkedWorkItem !== null,
    settings: args.settings,
    executionHostId,
    repoId: args.linkedWorkItem?.repoId ?? '',
    workspaceKind: 'folder',
    hasDraftPrompt: Boolean(launchText) && promptDelivery !== 'submit-after-ready',
    launchText: launchText ?? args.note,
    nativeChatTranscriptIsLocalReadable: !args.projectGroup.connectionId,
    initialSessionOptions: args.initialSessionOptions,
    requiresTuiLaunchCustomization:
      args.agent !== null &&
      (hasExplicitTuiAgentArgs(args.agent, args.agentArgs) ||
        hasExplicitTuiLaunchCustomization(args.settings, args.agent))
  })
  return { launchText, resolution }
}
