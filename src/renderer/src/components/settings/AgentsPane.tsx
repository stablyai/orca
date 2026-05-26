import { useMemo, useState } from 'react'
import { Check, ChevronDown, ExternalLink, RefreshCw, Terminal } from 'lucide-react'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AGENT_STATUS_HOOKS_DESCRIPTION, AGENT_STATUS_HOOKS_TITLE } from './agent-status-hooks-copy'
import { SettingsBadge, SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'

export { AGENTS_PANE_SEARCH_ENTRIES } from './agents-search'

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

type AgentRowProps = {
  agentId: TuiAgent
  label: string
  homepageUrl: string
  defaultCmd: string
  isDetected: boolean
  isDefault: boolean
  cmdOverride: string | undefined
  onSetDefault: () => void
  onSaveOverride: (value: string) => void
}

type AgentCommandOverrideInputProps = {
  defaultCmd: string
  cmdOverride: string | undefined
  onSaveOverride: (value: string) => void
}

function AgentCommandOverrideInput({
  defaultCmd,
  cmdOverride,
  onSaveOverride
}: AgentCommandOverrideInputProps): React.JSX.Element {
  const draftSeed = cmdOverride ?? defaultCmd
  const [cmdDraft, setCmdDraft] = useState(draftSeed)

  const commitCmd = (): void => {
    const trimmed = cmdDraft.trim()
    if (!trimmed || trimmed === defaultCmd) {
      onSaveOverride('')
      setCmdDraft(defaultCmd)
    } else {
      onSaveOverride(trimmed)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">Command</span>
      <Input
        value={cmdDraft}
        onChange={(e) => setCmdDraft(e.target.value)}
        onBlur={commitCmd}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitCmd()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setCmdDraft(draftSeed)
            e.currentTarget.blur()
          }
        }}
        placeholder={defaultCmd}
        spellCheck={false}
        className="h-7 flex-1 font-mono text-xs"
      />
      {cmdOverride && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            onSaveOverride('')
            setCmdDraft(defaultCmd)
          }}
          className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
        >
          Reset
        </Button>
      )}
    </div>
  )
}

function AgentRow({
  agentId,
  label,
  homepageUrl,
  defaultCmd,
  isDetected,
  isDefault,
  cmdOverride,
  onSetDefault,
  onSaveOverride
}: AgentRowProps): React.JSX.Element {
  const [cmdOpen, setCmdOpen] = useState(Boolean(cmdOverride))

  return (
    <div className={cn('py-3', !isDetected && 'opacity-60')}>
      <div className="flex items-center gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          <AgentIcon agent={agentId} size={16} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium leading-none">{label}</span>
            {isDetected ? (
              <SettingsBadge tone="accent">Detected</SettingsBadge>
            ) : (
              <SettingsBadge tone="muted">Not installed</SettingsBadge>
            )}
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {cmdOverride ? (
              <span>
                <span className="text-muted-foreground/60 line-through">{defaultCmd}</span>
                <span className="ml-1.5 text-foreground/80">{cmdOverride}</span>
              </span>
            ) : (
              defaultCmd
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isDetected && (
            <Button
              type="button"
              variant={isDefault ? 'secondary' : 'ghost'}
              size="xs"
              onClick={onSetDefault}
              title={isDefault ? 'Default agent' : 'Set as default'}
              className="h-7 gap-1 text-xs"
            >
              {isDefault && <Check className="size-3" />}
              {isDefault ? 'Default' : 'Set default'}
            </Button>
          )}

          {isDetected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setCmdOpen((prev) => !prev)}
              title="Customize command"
              aria-expanded={cmdOpen}
              className={cn(
                'size-7 text-muted-foreground hover:text-foreground',
                (cmdOpen || cmdOverride) && 'text-foreground'
              )}
            >
              <Terminal className="size-3.5" />
            </Button>
          )}

          <a
            href={homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={isDetected ? 'Docs' : 'Install'}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>

          {isDetected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setCmdOpen((prev) => !prev)}
              aria-label={cmdOpen ? 'Collapse command override' : 'Expand command override'}
              className="size-7 text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', cmdOpen && 'rotate-180')}
              />
            </Button>
          )}
        </div>
      </div>

      {isDetected && cmdOpen && (
        <div className="mt-3 pl-10">
          {/* Why: key by the persisted seed so settings changes reset the draft during reconciliation, not in a follow-up effect commit. */}
          <AgentCommandOverrideInput
            key={cmdOverride ?? defaultCmd}
            defaultCmd={defaultCmd}
            cmdOverride={cmdOverride}
            onSaveOverride={onSaveOverride}
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Override the binary path or name used to launch this agent.
          </p>
        </div>
      )}
    </div>
  )
}

type DefaultAgentPillProps = {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function DefaultAgentPill({ active, onClick, children }: DefaultAgentPillProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active
          ? 'border-muted-foreground/40 bg-accent font-medium text-accent-foreground'
          : 'border-border bg-background/50 text-muted-foreground hover:border-muted-foreground/35 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

export function AgentsPane({ settings, updateSettings }: AgentsPaneProps): React.JSX.Element {
  const { detectedIds: detectedList, isRefreshing, refresh } = useDetectedAgents()
  // Why: refresh re-spawns the user's login shell to re-capture PATH
  // (preflight:refreshAgents on the main side). This handles the
  // "installed a new CLI, Orca doesn't see it yet" case without a restart.
  const handleRefresh = (): void => {
    void refresh()
  }
  const detectedIds = useMemo<Set<string> | null>(
    () => (detectedList ? new Set(detectedList) : null),
    [detectedList]
  )

  const defaultAgent = settings.defaultTuiAgent
  const cmdOverrides = settings.agentCmdOverrides ?? {}

  const setDefault = (id: TuiAgent | 'blank' | null): void => {
    updateSettings({ defaultTuiAgent: id })
  }

  const saveOverride = (id: TuiAgent, value: string): void => {
    const next = { ...cmdOverrides }
    if (value) {
      next[id] = value
    } else {
      delete next[id]
    }
    updateSettings({ agentCmdOverrides: next })
  }

  const detectedAgents = AGENT_CATALOG.filter((a) => detectedIds === null || detectedIds.has(a.id))
  const undetectedAgents = AGENT_CATALOG.filter(
    (a) => detectedIds !== null && !detectedIds.has(a.id)
  )

  // Why: 'blank' is an explicit no-agent preference, not an auto fallback,
  // so the Auto pill should only light up when the default is null OR when a
  // selected agent id is no longer detected on PATH.
  const isAutoDefault =
    defaultAgent === null || (defaultAgent !== 'blank' && !detectedIds?.has(defaultAgent))
  const isBlankDefault = defaultAgent === 'blank'

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <SettingsSubsectionHeader
          title="Default Agent"
          description="Pre-selected agent when opening a new workspace."
        />

        <div className="flex flex-wrap gap-2">
          <DefaultAgentPill active={isAutoDefault} onClick={() => setDefault(null)}>
            {isAutoDefault && <Check className="size-3.5" />}
            Auto
          </DefaultAgentPill>

          {/* Why: users who prefer to open a raw shell by default need a
              first-class "no agent" choice here — without it, the Auto pill
              is the closest option but silently launches the first detected
              agent, which is the opposite of what they want. */}
          <DefaultAgentPill active={isBlankDefault} onClick={() => setDefault('blank')}>
            <Terminal className="size-3.5" />
            No agent (blank terminal)
            {isBlankDefault && <Check className="size-3.5" />}
          </DefaultAgentPill>

          {detectedAgents.map((agent) => {
            const isActive = defaultAgent === agent.id
            return (
              <DefaultAgentPill
                key={agent.id}
                active={isActive}
                onClick={() => setDefault(agent.id)}
              >
                <AgentIcon agent={agent.id} size={14} />
                {agent.label}
                {isActive && <Check className="size-3.5" />}
              </DefaultAgentPill>
            )
          })}
        </div>
      </section>

      <AgentStatusHooksSetting settings={settings} updateSettings={updateSettings} />

      <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />

      {detectedAgents.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2">
                Installed
                <SettingsBadge tone="accent">{detectedAgents.length} detected</SettingsBadge>
              </span>
            }
            action={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={handleRefresh}
                disabled={isRefreshing}
                title="Re-read your shell PATH and re-detect installed agents"
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
                {isRefreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            }
          />

          <div className="divide-y divide-border/40">
            {detectedAgents.map((agent) => (
              <AgentRow
                key={agent.id}
                agentId={agent.id}
                label={agent.label}
                homepageUrl={agent.homepageUrl}
                defaultCmd={agent.cmd}
                isDetected
                isDefault={defaultAgent === agent.id}
                cmdOverride={cmdOverrides[agent.id]}
                onSetDefault={() => setDefault(agent.id)}
                onSaveOverride={(v) => saveOverride(agent.id, v)}
              />
            ))}
          </div>
        </section>
      )}

      {undetectedAgents.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2 text-muted-foreground">
                Available to install
                <SettingsBadge tone="muted">{undetectedAgents.length} agents</SettingsBadge>
              </span>
            }
          />

          <div className="divide-y divide-border/40">
            {undetectedAgents.map((agent) => (
              <AgentRow
                key={agent.id}
                agentId={agent.id}
                label={agent.label}
                homepageUrl={agent.homepageUrl}
                defaultCmd={agent.cmd}
                isDetected={false}
                isDefault={false}
                cmdOverride={undefined}
                onSetDefault={() => {}}
                onSaveOverride={() => {}}
              />
            ))}
          </div>
        </section>
      )}

      {detectedIds === null && (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/50 py-6 text-sm text-muted-foreground">
          Detecting installed agents…
        </div>
      )}
    </div>
  )
}

export function AgentStatusHooksSetting({
  settings,
  updateSettings
}: AgentsPaneProps): React.JSX.Element {
  const enabled = settings.agentStatusHooksEnabled !== false
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={AGENT_STATUS_HOOKS_TITLE}
        description={AGENT_STATUS_HOOKS_DESCRIPTION}
        checked={enabled}
        onChange={() =>
          updateSettings({
            agentStatusHooksEnabled: !enabled
          })
        }
        ariaLabel={AGENT_STATUS_HOOKS_TITLE}
      />
    </section>
  )
}
