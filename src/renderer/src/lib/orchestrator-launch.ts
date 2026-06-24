import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildDirectWorkItemStartupOpts } from '@/lib/launch-work-item-direct-agent'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { createDirectorWorktreeShell } from '@/lib/director-worktree-shell'
import { translate } from '@/i18n/i18n'
import type { Project, TuiAgent } from '../../../shared/types'

// Why: the coordinator session is a normal Claude Code agent that starts by
// invoking the orchestrate skill, exactly as a user would type it by hand.
const ORCASTRATE_PROMPT = '/orcastrate'

// Why: a cold agent boot (model load + first-run banners, slower still in dev)
// can exceed the default paste window; give it room so the prompt lands.
const ORCASTRATE_PASTE_TIMEOUT_MS = 90_000

// Why: an Orcastrator is the coordinator, not a worker — default it to Claude
// Code unless the user has chosen a different default agent (a `'blank'`
// default means "plain shell", which can't coordinate, so fall back to claude).
function resolveCoordinatorAgent(defaultTuiAgent: TuiAgent | 'blank' | null | undefined): TuiAgent {
  return defaultTuiAgent && defaultTuiAgent !== 'blank' ? defaultTuiAgent : 'claude'
}

export type LaunchOrchestratorOptions = {
  /** Optional human name for the director (shown in the ORCASTRATORS list). */
  name?: string
  /** Coordinator agent override; defaults to the user's default agent. */
  agent?: TuiAgent
  /** Initial task the director should plan — seeded after `/orcastrate` so it
   *  starts planning instead of asking "what's the task?". */
  prompt?: string
}

/**
 * Launch an Orcastrator (director) for a project. The director is a first-class
 * entity, not a worktree agent: it runs in its *own* dedicated worktree (hidden
 * from Projects, shown only in the ORCASTRATORS section) so it never couples to
 * the project's primary checkout. Creates the worktree, launches the coordinator
 * agent in it, seeds `/orcastrate` (+ the task), and registers it.
 */
export async function launchOrchestratorForProject(
  project: Project,
  options?: LaunchOrchestratorOptions
): Promise<boolean> {
  const store = useAppStore.getState()
  const settings = store.settings
  const agent = options?.agent ?? resolveCoordinatorAgent(settings?.defaultTuiAgent)
  const label = options?.name?.trim() || project.displayName
  const task = options?.prompt?.trim()
  const promptContent = task ? `${ORCASTRATE_PROMPT} ${task}` : ORCASTRATE_PROMPT

  // Why: the worktree shell is identical for both director kinds; the Orcastrator
  // is just this shell PLUS the coordinator agent + /orcastrate seeded below.
  const shell = await createDirectorWorktreeShell(project, { label })
  if (!shell) {
    return false
  }
  const { worktreeId, setup } = shell

  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: settings?.agentCmdOverrides ?? {},
    platform: CLIENT_PLATFORM,
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings?.agentDefaultEnv),
    allowEmptyPromptLaunch: true
  })

  // Why: a director is launched programmatically — reveal it in the sidebar +
  // Mission Control DAG, but suppress the active-tab switch so the user is not
  // yanked off their current worktree when the Orcastrator boots.
  const activation = activateAndRevealWorktree(worktreeId, {
    sidebarRevealBehavior: 'auto',
    setup,
    suppressActivation: true,
    ...buildDirectWorkItemStartupOpts(agent, startupPlan, 'sidebar')
  })
  if (!activation) {
    toast.error(
      translate('auto.lib.orchestrator.launch.no_workspace', 'Could not open the Orcastrator.')
    )
    return false
  }

  store.registerOrchestrator({
    id: worktreeId,
    projectId: project.id,
    projectName: label,
    worktreeId,
    tabId: activation.primaryTabId ?? '',
    launchedAt: Date.now()
  })

  // Why: the agent command runs when the PTY mounts; deliver /orcastrate once
  // the TUI is accepting input. Background so the click doesn't block on boot,
  // with a generous timeout since cold boots are slow.
  if (activation.primaryTabId) {
    void pasteDraftWhenAgentReady({
      tabId: activation.primaryTabId,
      content: promptContent,
      agent,
      submit: true,
      forcePaste: true,
      timeoutMs: ORCASTRATE_PASTE_TIMEOUT_MS
    })
  }
  return true
}
