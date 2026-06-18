import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TuiAgent } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

function seedCommandCodeSubmittedPromptStatus(tabId: string, prompt: string): void {
  const state = useAppStore.getState()
  const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
  if (!leafId) {
    return
  }
  try {
    state.setAgentStatus(makePaneKey(tabId, leafId), {
      state: 'working',
      prompt,
      agentType: 'command-code'
    })
  } catch {
    // Best-effort UI seed. Real hooks still own refinement/completion.
  }
}

export function scheduleAgentDraftPasteAfterLaunch(args: {
  agent: TuiAgent
  content: string
  forcePaste: boolean
  onPromptDelivered?: () => void
  submit: boolean
  tabId: string
  worktreeId: string
}): void {
  const { agent, content, forcePaste, onPromptDelivered, submit, tabId, worktreeId } = args
  void pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit,
    forcePaste,
    onTimeout: () => {
      const state = useAppStore.getState()
      const tabsForWorktree = state.tabsByWorktree[worktreeId] ?? []
      const tab = tabsForWorktree.find((entry) => entry.id === tabId)
      // Why: if the PTY never spawned, QuickLaunch's 5s watchdog already
      // surfaced the launch failure. Don't double-toast for the same root cause.
      if (!tab || tab.ptyId === null || state.activeWorktreeId !== worktreeId) {
        return
      }
      const label = submit ? 'prompt' : 'notes'
      toast.message(
        translate(
          'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
          "Your {{value0}} wasn't sent — paste it once the agent is ready.",
          { value0: label }
        )
      )
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(agent)
      })
    }
  }).then((delivered) => {
    if (!delivered) {
      return
    }
    if (agent === 'command-code' && submit) {
      seedCommandCodeSubmittedPromptStatus(tabId, content)
    }
    onPromptDelivered?.()
  })
}
