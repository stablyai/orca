import { useEffect, useState } from 'react'
import { Copy, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { EXPERIMENTAL_PANE_SEARCH_ENTRIES } from './experimental-search'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'

// Why: agents with a per-agent hook-service module under src/main that posts
// status to the shared agent-hooks server. Keep this list in sync with the
// hook-service.ts files — any agent without one will not appear in the inline
// per-workspace-card agent activity list even when the experimental setting
// is on.
const AGENT_DASHBOARD_SUPPORTED_AGENTS: readonly TuiAgent[] = [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'opencode'
] as const

// Why: both AGENT_DASHBOARD_SUPPORTED_AGENTS and AGENT_CATALOG are static
// module-level constants, so the resolved {id, label} pairs never change at
// runtime. Computing this inside SupportedAgentsDisclaimer was O(N×M) work on
// every parent re-render — notably on every keystroke in the settings search —
// for a list that can only change at build time. Hoisting it makes the cost
// a one-time module-load expense.
const SUPPORTED_AGENT_ENTRIES: readonly { id: TuiAgent; label: string }[] =
  AGENT_DASHBOARD_SUPPORTED_AGENTS.map((id) => {
    const entry = AGENT_CATALOG.find((a) => a.id === id)
    return { id, label: entry?.label ?? id }
  })

export { EXPERIMENTAL_PANE_SEARCH_ENTRIES }

const ORCHESTRATION_SKILL_INSTALL_COMMAND =
  'npx skills add https://github.com/stablyai/orca --skill orchestration'

type ExperimentalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Hidden-experimental group is only rendered once the user has unlocked
   *  it via Shift-clicking the Experimental sidebar entry. */
  hiddenExperimentalUnlocked?: boolean
}

export function ExperimentalPane({
  settings,
  updateSettings,
  hiddenExperimentalUnlocked = false
}: ExperimentalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  // Why: when the user flips the experimental toggle ON, ensure the
  // 'inline-agents' view-mode checkbox is added to the Workspaces view
  // options so the inline agent activity list is visible without a second
  // click. Users who previously had the toggle on in an earlier rc get the
  // same behavior retroactively via the persistence migration in
  // main/persistence.ts — this handler covers fresh opt-ins going forward.
  const toggleWorktreeCardProperty = useAppStore((s) => s.toggleWorktreeCardProperty)
  // Why: the "enabled at startup" flags are the effective runtime state, read
  // directly from main once on mount. Each banner compares the user's current
  // setting against this snapshot to tell them a restart is still required.
  // null = not yet fetched (banner stays hidden to avoid a flash).
  const [agentDashboardEnabledAtStartup, setAgentDashboardEnabledAtStartup] = useState<
    boolean | null
  >(null)
  const [relaunching, setRelaunching] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.app
      .getRuntimeFlags()
      .then((flags) => {
        if (!cancelled) {
          setAgentDashboardEnabledAtStartup(flags.agentDashboardEnabledAtStartup)
        }
      })
      .catch(() => {
        // Non-fatal; banner will just never show if the IPC is unavailable.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const showAgentDashboard = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_PANE_SEARCH_ENTRIES[0]
  ])
  const showOrchestration = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_PANE_SEARCH_ENTRIES[1]
  ])

  const [orchestrationEnabled, setOrchestrationEnabled] = useState<boolean>(() => {
    return localStorage.getItem('orca.orchestration.enabled') === '1'
  })

  const [orchestrationSkillInstalled, setOrchestrationSkillInstalled] = useState<boolean>(() => {
    return localStorage.getItem('orca.orchestration.skillInstalled') === '1'
  })

  const toggleOrchestration = (value: boolean): void => {
    setOrchestrationEnabled(value)
    localStorage.setItem('orca.orchestration.enabled', value ? '1' : '0')
  }

  const markOrchestrationSkillInstalled = (value: boolean): void => {
    setOrchestrationSkillInstalled(value)
    localStorage.setItem('orca.orchestration.skillInstalled', value ? '1' : '0')
  }

  const handleCopyOrchestrationCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(ORCHESTRATION_SKILL_INSTALL_COMMAND)
      toast.success('Copied install command. Run it in your agent project.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy command.')
    }
  }

  const pendingAgentDashboardRestart =
    agentDashboardEnabledAtStartup !== null &&
    settings.experimentalAgentDashboard !== agentDashboardEnabledAtStartup

  const handleRelaunch = async (): Promise<void> => {
    if (relaunching) {
      return
    }
    setRelaunching(true)
    try {
      await window.api.app.relaunch()
    } catch {
      setRelaunching(false)
    }
  }

  return (
    <div className="space-y-4">
      {showAgentDashboard ? (
        <SearchableSetting
          title="Detailed agent activity"
          description="Shows each agent’s live status, prompt, and last message inside its workspace card."
          keywords={[
            'experimental',
            'agent',
            'activity',
            'status',
            'live',
            'workspace',
            'card',
            'inline',
            'hook',
            'claude',
            'codex',
            'gemini',
            'sidebar'
          ]}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-1.5">
              <Label>Detailed agent activity</Label>
              <p className="text-xs text-muted-foreground">
                Shows each agent&apos;s live status, current prompt, and last message inline inside
                its workspace card. Requires an app restart, and tracks agents started in new
                terminals opened after the restart.
              </p>
              <SupportedAgentsDisclaimer />
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalAgentDashboard}
              onClick={() => {
                const next = !settings.experimentalAgentDashboard
                updateSettings({ experimentalAgentDashboard: next })
                if (next) {
                  // Why: mirrors the one-shot persistence migration for users
                  // who already had the toggle on before 'inline-agents'
                  // existed. Reading from the live store keeps this honest
                  // instead of stale-propping through a parent re-render.
                  const currentProps = useAppStore.getState().worktreeCardProperties ?? []
                  if (!currentProps.includes('inline-agents')) {
                    toggleWorktreeCardProperty('inline-agents')
                  }
                }
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalAgentDashboard ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalAgentDashboard ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {pendingAgentDashboardRestart ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
                  Restart required
                </p>
                <p className="text-xs text-muted-foreground">
                  {settings.experimentalAgentDashboard
                    ? 'Restart Orca to finish enabling detailed agent activity.'
                    : 'Restart Orca to finish disabling detailed agent activity.'}
                </p>
              </div>
              <Button
                size="sm"
                variant="default"
                className="shrink-0 gap-1.5"
                disabled={relaunching}
                onClick={handleRelaunch}
              >
                <RotateCw className={`size-3 ${relaunching ? 'animate-spin' : ''}`} />
                {relaunching ? 'Restarting…' : 'Restart now'}
              </Button>
            </div>
          ) : null}
        </SearchableSetting>
      ) : null}

      {showOrchestration ? (
        <SearchableSetting
          title="Agent Orchestration"
          description="Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates."
          keywords={EXPERIMENTAL_PANE_SEARCH_ENTRIES[1].keywords}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>Agent Orchestration</Label>
              <p className="text-xs text-muted-foreground">
                Coordinate multiple coding agents with messaging, task DAGs, dispatch with preamble
                injection, decision gates, and coordinator loops. Experimental — APIs may change.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={orchestrationEnabled}
              onClick={() => toggleOrchestration(!orchestrationEnabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                orchestrationEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  orchestrationEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {orchestrationEnabled ? (
            <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Install Orchestration Skill</p>
                <p className="text-xs text-muted-foreground">
                  Run this in your agent project so agents learn to use inter-agent orchestration
                  commands.
                </p>
              </div>
              <div className="flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                <code className="flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
                  {ORCHESTRATION_SKILL_INSTALL_COMMAND}
                </code>
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void handleCopyOrchestrationCommand()}
                        aria-label="Copy orchestration skill install command"
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Copy
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  {orchestrationSkillInstalled
                    ? 'Marked as installed on this machine.'
                    : "Check off once you've run it in your project."}
                </span>
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => markOrchestrationSkillInstalled(!orchestrationSkillInstalled)}
                >
                  {orchestrationSkillInstalled ? 'Undo' : 'I ran it'}
                </button>
              </div>
            </div>
          ) : null}
        </SearchableSetting>
      ) : null}

      {hiddenExperimentalUnlocked ? <HiddenExperimentalGroup /> : null}
    </div>
  )
}

function SupportedAgentsDisclaimer(): React.JSX.Element {
  return (
    <div className="space-y-1 pt-0.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span>Supported agents:</span>
        {SUPPORTED_AGENT_ENTRIES.map(({ id, label }) => (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5"
            title={label}
          >
            <AgentIcon agent={id} size={12} />
            <span className="text-[11px] leading-none text-foreground/80">{label}</span>
          </span>
        ))}
      </div>
      <p className="text-[11px] italic">
        We&apos;re currently working on support for more agent CLIs.
      </p>
    </div>
  )
}

// Why: anything in this group is deliberately unfinished or staff-only. The
// orange treatment (header tint, label colors) is the shared visual signal
// for hidden-experimental items so future entries inherit the same
// affordance without another round of styling decisions.
function HiddenExperimentalGroup(): React.JSX.Element {
  return (
    <section className="space-y-3 rounded-lg border border-orange-500/40 bg-orange-500/5 p-3">
      <div className="space-y-0.5">
        <h4 className="text-sm font-semibold text-orange-500 dark:text-orange-300">
          Hidden experimental
        </h4>
        <p className="text-xs text-orange-500/80 dark:text-orange-300/80">
          Unlisted toggles for internal testing. Nothing here is supported.
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2.5">
        <div className="min-w-0 shrink space-y-0.5">
          <Label className="text-orange-600 dark:text-orange-300">Placeholder toggle</Label>
          <p className="text-xs text-orange-600/80 dark:text-orange-300/80">
            Does nothing today. Reserved as the first slot for hidden experimental options.
          </p>
        </div>
        <button
          type="button"
          aria-label="Placeholder toggle"
          className="relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full border border-orange-500/40 bg-orange-500/20 opacity-70"
          disabled
        >
          <span className="inline-block h-3.5 w-3.5 translate-x-0.5 transform rounded-full bg-orange-200 shadow-sm dark:bg-orange-100" />
        </button>
      </div>
    </section>
  )
}
