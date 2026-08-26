import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { branchName } from '@/lib/git-utils'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { useAppStore } from '@/store'
import { useRepoById, useWorktreeById } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  isTuiAgentEnabled
} from '../../../../shared/tui-agent-selection'

type FirstProjectTerminalWelcomeProps = {
  tabId: string
  worktreeId: string
  backgroundColor: string
  foregroundColor: string
  accentColor: string
  fontFamily: string
  fontSize: number
}

type WelcomeSurfaceStyle = CSSProperties & {
  '--orca-welcome-accent': string
  '--orca-welcome-foreground': string
}

const optionClassName =
  'group flex w-full items-start gap-3 rounded-sm px-2 py-2 text-left transition-colors hover:bg-[color:color-mix(in_srgb,var(--orca-welcome-foreground)_7%,transparent)] focus-visible:bg-[color:color-mix(in_srgb,var(--orca-welcome-foreground)_10%,transparent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45'

function optionDescriptionColor(): string {
  return 'color-mix(in srgb, var(--orca-welcome-foreground) 62%, transparent)'
}

export function FirstProjectTerminalWelcome({
  tabId,
  worktreeId,
  backgroundColor,
  foregroundColor,
  accentColor,
  fontFamily,
  fontSize
}: FirstProjectTerminalWelcomeProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const worktree = useWorktreeById(worktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  const settings = useAppStore((state) => state.settings)
  const workspaceShortcut = useOptionalShortcutLabel('workspace.create')
  const agentDetectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds, isLoading: agentsLoading } = useDetectedAgents(agentDetectionTarget)
  const configuredAgent = settings?.defaultTuiAgent
  const disabledAgents = settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  const defaultAgent: TuiAgent | null =
    configuredAgent &&
    configuredAgent !== 'blank' &&
    isTuiAgentEnabled(configuredAgent, disabledAgents)
      ? configuredAgent
      : null
  const defaultAgentAvailable = Boolean(defaultAgent && detectedIds?.includes(defaultAgent))
  const defaultAgentLabel = useMemo(
    () =>
      defaultAgent
        ? (getAgentCatalog().find((agent) => agent.id === defaultAgent)?.label ?? defaultAgent)
        : null,
    [defaultAgent]
  )
  const projectLabel = repo?.displayName || repo?.path || worktree?.displayName || worktreeId
  const branchLabel = worktree ? branchName(worktree.branch) || 'HEAD' : 'HEAD'

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const dismissToTerminal = useCallback(() => {
    useAppStore.getState().dismissFirstProjectTerminalWelcome(tabId)
    focusTerminalTabSurface(tabId)
  }, [tabId])

  const openWorkspaceComposer = useCallback(() => {
    const state = useAppStore.getState()
    state.dismissFirstProjectTerminalWelcome(tabId)
    state.recordFeatureInteraction('workspace-creation')
    state.openModal('new-workspace-composer', {
      ...(worktree?.repoId ? { initialRepoId: worktree.repoId } : {}),
      telemetrySource: 'onboarding'
    })
  }, [tabId, worktree?.repoId])

  const launchDefaultAgent = useCallback(() => {
    if (!defaultAgent || !defaultAgentAvailable) {
      return
    }
    const state = useAppStore.getState()
    const groupId = state.unifiedTabsByWorktree[worktreeId]?.find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
    )?.groupId
    const result = launchAgentInNewTab({
      agent: defaultAgent,
      worktreeId,
      ...(groupId ? { groupId } : {}),
      launchSource: 'onboarding'
    })
    if (!result) {
      toast.error(
        translate(
          'auto.components.terminalPane.FirstProjectTerminalWelcome.launchFailed',
          'Could not build launch command for {{value0}}.',
          { value0: defaultAgentLabel ?? defaultAgent }
        )
      )
      return
    }

    state.dismissFirstProjectTerminalWelcome(tabId)
    if (result.tabId) {
      // Why: launching into a fresh tab and retiring the unexplained blank shell
      // preserves the pane while using the shared local/SSH startup path.
      state.closeTab(tabId, {
        captureRecentlyClosed: false,
        reason: 'cleanup',
        recordInteraction: false
      })
      focusTerminalTabSurface(result.tabId)
    }
  }, [defaultAgent, defaultAgentAvailable, defaultAgentLabel, tabId, worktreeId])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key === '1') {
        event.preventDefault()
        openWorkspaceComposer()
        return
      }
      if (event.key === '2' && defaultAgentAvailable) {
        event.preventDefault()
        launchDefaultAgent()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        dismissToTerminal()
        return
      }
      if (event.key === 'Enter' && event.target === event.currentTarget) {
        event.preventDefault()
        dismissToTerminal()
      }
    },
    [defaultAgentAvailable, dismissToTerminal, launchDefaultAgent, openWorkspaceComposer]
  )

  const optionTwoDescription = agentsLoading
    ? translate(
        'auto.components.terminalPane.FirstProjectTerminalWelcome.checkingAgent',
        'Checking whether {{value0}} is available here…',
        { value0: defaultAgentLabel ?? 'your default agent' }
      )
    : defaultAgentAvailable
      ? translate(
          'auto.components.terminalPane.FirstProjectTerminalWelcome.currentCheckoutWarning',
          'Changes will be made directly on {{value0}}.',
          { value0: branchLabel }
        )
      : translate(
          'auto.components.terminalPane.FirstProjectTerminalWelcome.agentUnavailable',
          'No default agent is available here. Choose one in workspace setup.'
        )
  const style: WelcomeSurfaceStyle = {
    '--orca-welcome-accent': accentColor,
    '--orca-welcome-foreground': foregroundColor,
    backgroundColor,
    color: foregroundColor,
    fontFamily,
    fontSize: `${fontSize}px`
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-project-terminal-welcome-title"
      aria-describedby="first-project-terminal-welcome-description"
      data-first-project-terminal-welcome
      tabIndex={-1}
      className="absolute inset-0 z-[45] overflow-auto outline-none scrollbar-sleek"
      style={style}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          rootRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <div className="w-full max-w-3xl px-6 py-7 leading-relaxed sm:px-8 sm:py-9">
        <h2
          id="first-project-terminal-welcome-title"
          className="mb-4 text-[1.05em] font-bold tracking-[0.18em] text-[var(--orca-welcome-accent)]"
        >
          {translate('auto.components.terminalPane.FirstProjectTerminalWelcome.brand', 'ORCA')}
        </h2>
        <div className="mb-5 space-y-0.5">
          <p>
            {translate(
              'auto.components.terminalPane.FirstProjectTerminalWelcome.projectOpened',
              'Project opened: {{value0}}',
              { value0: projectLabel }
            )}
          </p>
          <p>
            {translate(
              'auto.components.terminalPane.FirstProjectTerminalWelcome.branch',
              'Branch: {{value0}}',
              { value0: branchLabel }
            )}
          </p>
        </div>
        <p
          id="first-project-terminal-welcome-description"
          className="mb-5 max-w-2xl"
          style={{ color: optionDescriptionColor() }}
        >
          {translate(
            'auto.components.terminalPane.FirstProjectTerminalWelcome.explanation',
            'This is a normal terminal. Orca works best when each task gets a separate Git worktree, so changes stay off {{value0}}.',
            { value0: branchLabel }
          )}
        </p>

        <div className="-mx-2 space-y-1">
          <button type="button" className={optionClassName} onClick={openWorkspaceComposer}>
            <span className="w-4 shrink-0 font-bold text-[var(--orca-welcome-accent)]">1</span>
            <span>
              <span className="block font-semibold">
                {translate(
                  'auto.components.terminalPane.FirstProjectTerminalWelcome.isolatedWorkspace',
                  'Create an isolated workspace (recommended)'
                )}
              </span>
              <span className="block" style={{ color: optionDescriptionColor() }}>
                {translate(
                  'auto.components.terminalPane.FirstProjectTerminalWelcome.isolatedWorkspaceDescription',
                  'Choose a task name and agent before Orca creates the worktree.'
                )}
              </span>
            </span>
          </button>

          <button
            type="button"
            className={optionClassName}
            disabled={!defaultAgentAvailable}
            onClick={launchDefaultAgent}
          >
            <span className="w-4 shrink-0 font-bold text-[var(--orca-welcome-accent)]">2</span>
            <span>
              <span className="block font-semibold">
                {defaultAgentLabel
                  ? translate(
                      'auto.components.terminalPane.FirstProjectTerminalWelcome.launchAgent',
                      'Launch {{value0}} in this checkout',
                      { value0: defaultAgentLabel }
                    )
                  : translate(
                      'auto.components.terminalPane.FirstProjectTerminalWelcome.launchAgentGeneric',
                      'Launch an agent in this checkout'
                    )}
              </span>
              <span className="block" style={{ color: optionDescriptionColor() }}>
                {optionTwoDescription}
              </span>
            </span>
          </button>

          <button type="button" className={optionClassName} onClick={dismissToTerminal}>
            <span className="w-4 shrink-0 text-[var(--orca-welcome-accent)]">↵</span>
            <span>
              <span className="block font-semibold">
                {translate(
                  'auto.components.terminalPane.FirstProjectTerminalWelcome.useTerminal',
                  'Use this terminal as-is'
                )}
              </span>
              <span className="block" style={{ color: optionDescriptionColor() }}>
                {translate(
                  'auto.components.terminalPane.FirstProjectTerminalWelcome.useTerminalDescription',
                  'Press Enter or Escape, then run any shell command.'
                )}
              </span>
            </span>
          </button>
        </div>

        {workspaceShortcut ? (
          <p className="mt-5" style={{ color: optionDescriptionColor() }}>
            {translate(
              'auto.components.terminalPane.FirstProjectTerminalWelcome.shortcut',
              'Create another workspace anytime with {{value0}}.',
              { value0: workspaceShortcut }
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
