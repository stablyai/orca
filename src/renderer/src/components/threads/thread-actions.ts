import { getStructuredLaunchStateBySessionId } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { isPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { afterPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionOwnerForTab } from '@/runtime/structured-agent-session-owner'
import { eligibleThreadProjects, type ThreadProject } from './thread-projects'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  useThreadNavigation,
  clearThreadSelection,
  requestThreadProjectAdd
} from './thread-navigation'

export async function openNewThread(): Promise<void> {
  const state = useAppStore.getState()
  if (!state.settings?.experimentalThreads) {
    return
  }
  const request = clearThreadSelection()
  const projects = await eligibleThreadProjects(state)
  if (useThreadNavigation.getState().request !== request) {
    return
  }
  if (!projects.length) {
    requestThreadProjectAdd()
    useAppStore.getState().openModal('add-repo')
    return
  }
  useAppStore.getState().setActiveView('terminal')
  useThreadNavigation.setState({
    selection: { kind: 'new', projectKey: projects[0].key, draftId: createBrowserUuid() }
  })
}

export function selectThread(tab: Tab): void {
  const state = useAppStore.getState()
  const hostId = structuredAgentSessionOwnerForTab(state, tab)
  if (!hostId) {
    return
  }
  if (
    !activateAndRevealWorktree(tab.worktreeId, {
      executionHostId: hostId,
      providesInitialSurface: true
    })
  ) {
    return
  }
  state.setActiveView('terminal')
  activateStructuredAgentSessionTab({
    worktreeId: tab.worktreeId,
    tabId: tab.id,
    target: structuredAgentSessionTargetForHost(hostId) ?? undefined
  })
}

export function sendNewThread(
  project: ThreadProject,
  text: string,
  choices?: { agent: TuiAgent; launchOptions?: Record<string, string> }
) {
  const state = useAppStore.getState()
  const agent = state.settings?.defaultTuiAgent
  const plan = adoptAgentSessionLaunchVerdict({
    route: 'structured-native-chat',
    requestedSurface: 'chat',
    surface: 'thread',
    requestId: newAgentLaunchRequestId(),
    agent: choices?.agent ?? (agent && agent !== 'blank' ? agent : 'claude'),
    ...(choices?.launchOptions ? { launchOptions: choices.launchOptions } : {}),
    worktreeId: project.worktree.id,
    executionHostId: project.hostId,
    prompt: text,
    promptDelivery: 'auto-submit'
  })
  const { selection, request } = useThreadNavigation.getState()
  let openedTabId: string | undefined
  let openedSessionId: string | undefined
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    target: { worktreeId: project.worktree.id, executionHostId: project.hostId },
    activate: false,
    onOpened: (tab) => {
      openedTabId = tab.id
      openedSessionId = tab.entityId
      afterPendingTab(tab.id, (shown) => {
        const current = useThreadNavigation.getState().selection
        if (
          !shown ||
          useThreadNavigation.getState().request !== request ||
          selection?.kind !== 'new' ||
          current?.kind !== 'new' ||
          current.draftId !== selection.draftId ||
          current.projectKey !== selection.projectKey
        ) {
          return
        }
        const visible = useAppStore.getState().getTab(shown)
        if (visible) {
          selectThread(visible)
        }
      })
    }
  })
  return (
    launch && {
      ...launch,
      ownsPrompt: () =>
        !!openedTabId &&
        (isPendingTab(openedTabId) ||
          !!useAppStore.getState().getTab(openedTabId) ||
          !!getStructuredLaunchStateBySessionId(openedSessionId ?? ''))
    }
  )
}
