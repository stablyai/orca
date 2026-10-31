import { afterPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  beginDesktopNavigation,
  canPresentDesktopNavigation,
  commitDesktopNavigation,
  type DesktopNavigationRequest
} from '@/lib/desktop-navigation'
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
  useThreadDraft,
  enterThreadDraft,
  captureThreadDraftSubmission,
  requestThreadProjectAdd
} from './thread-navigation'

export async function openNewThread(): Promise<void> {
  const state = useAppStore.getState()
  if (!state.settings?.experimentalThreads) {
    return
  }
  const request = beginDesktopNavigation(state, true)
  const projects = await eligibleThreadProjects(state)
  if (!canPresentDesktopNavigation(request)) {
    return
  }
  if (!projects.length) {
    requestThreadProjectAdd(request)
    useAppStore.getState().openModal('add-repo')
    return
  }
  commitDesktopNavigation(request, () => enterThreadDraft(projects[0].key, request))
}

export function selectThread(tab: Tab, request?: DesktopNavigationRequest): void {
  const state = useAppStore.getState()
  const hostId = structuredAgentSessionOwnerForTab(state, tab)
  if (!hostId) {
    return
  }
  const navigation = request ?? beginDesktopNavigation(state, true)
  commitDesktopNavigation(navigation, () => {
    if (
      !activateAndRevealWorktree(tab.worktreeId, {
        executionHostId: hostId,
        providesInitialSurface: true,
        navigation: navigation
      })
    ) {
      return
    }
    activateStructuredAgentSessionTab({
      worktreeId: tab.worktreeId,
      tabId: tab.id,
      target: structuredAgentSessionTargetForHost(hostId) ?? undefined,
      navigation
    })
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
  const selection = useThreadDraft.getState().draft
  const request = beginDesktopNavigation(state, true)
  const submission = captureThreadDraftSubmission(text)
  let openedTabId: string | undefined
  try {
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: {},
      target: { worktreeId: project.worktree.id, executionHostId: project.hostId },
      activate: false,
      onOpened: (tab) => {
        openedTabId = tab.id
        submission.allocated()
        afterPendingTab(tab.id, (shown) => {
          if (!shown || !canPresentDesktopNavigation(request) || selection?.kind !== 'new') {
            return
          }
          const visible = useAppStore.getState().getTab(shown)
          if (visible) {
            selectThread(visible, request)
          }
        })
      }
    })
    if (!launch) {
      submission.finish(false)
      return null
    }
    void launch.settlement.then((result) => {
      submission.finish(
        !openedTabId &&
          (result.kind === 'failed' || (result.kind === 'cancelled' && result.sessionId === null))
      )
    })
    return { ...launch, ownsPrompt: () => !!openedTabId }
  } catch (error) {
    submission.finish(false)
    throw error
  }
}
