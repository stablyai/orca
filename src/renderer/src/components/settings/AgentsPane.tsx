import { useMemo, useState } from 'react'
import { Check, ChevronDown, ExternalLink, RefreshCw, Terminal } from 'lucide-react'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'
import { AgentAwakeSetting } from './AgentAwakeSetting'

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
    <div
      className={cn(
        'group rounded-xl border transition-all',
        isDetected ? 'border-border/60 bg-card/60' : 'border-border/30 bg-card/20 opacity-60'
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Icon */}
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/60">
          <AgentIcon agent={agentId} size={18} />
        </div>

        {/* Name + status */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold leading-none">{label}</span>
            {isDetected ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                Detected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Not installed
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {cmdOverride ? (
              <span>
                <span className="text-muted-foreground/60 line-through">{defaultCmd}</span>
                <span className="ml-1.5 text-foreground/70">{cmdOverride}</span>
              </span>
            ) : (
              defaultCmd
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Set as default — only for detected agents */}
          {isDetected && (
            <button
              type="button"
              onClick={onSetDefault}
              title={isDefault ? 'Default agent' : 'Set as default'}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                isDefault
                  ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/20'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {isDefault && <Check className="size-3" />}
              {isDefault ? 'Default' : 'Set default'}
            </button>
          )}

          {/* Customize command — only for detected agents */}
          {isDetected && (
            <button
              type="button"
              onClick={() => setCmdOpen((prev) => !prev)}
              title="Customize command"
              className={cn(
                'flex size-7 items-center justify-center rounded-lg transition-colors',
                cmdOpen || cmdOverride
                  ? 'bg-muted/60 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              <Terminal className="size-3.5" />
            </button>
          )}

          {/* Homepage link */}
          <a
            href={homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={isDetected ? 'Docs' : 'Install'}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>

          {/* Expand chevron for cmd override */}
          {isDetected && (
            <button
              type="button"
              onClick={() => setCmdOpen((prev) => !prev)}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', cmdOpen && 'rotate-180')}
              />
            </button>
          )}
        </div>
      </div>

      {/* Command override row */}
      {isDetected && cmdOpen && (
        <div className="border-t border-border/40 px-4 py-3">
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
      {/* Default agent picker */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Default Agent</h3>
          <p className="text-xs text-muted-foreground">
            Pre-selected agent when opening a new workspace.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Auto option */}
          <button
            type="button"
            onClick={() => setDefault(null)}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all',
              isAutoDefault
                ? 'border-foreground/20 bg-foreground/8 font-medium ring-1 ring-foreground/15'
                : 'border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground'
            )}
          >
            {isAutoDefault && <Check className="size-3.5" />}
            Auto
          </button>

          {/* Why: users who prefer to open a raw shell by default need a
              first-class "no agent" choice here — without it, the Auto pill
              is the closest option but silently launches the first detected
              agent, which is the opposite of what they want. */}
          <button
            type="button"
            onClick={() => setDefault('blank')}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all',
              isBlankDefault
                ? 'border-foreground/20 bg-foreground/8 font-medium ring-1 ring-foreground/15'
                : 'border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <Terminal className="size-3.5" />
            No agent (blank terminal)
            {isBlankDefault && <Check className="size-3.5" />}
          </button>

          {/* Detected agent pills */}
          {detectedAgents.map((agent) => {
            const isActive = defaultAgent === agent.id
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => setDefault(agent.id)}
                className={cn(
                  'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all',
                  isActive
                    ? 'border-foreground/20 bg-foreground/8 font-medium ring-1 ring-foreground/15'
                    : 'border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground'
                )}
              >
                <AgentIcon agent={agent.id} size={14} />
                {agent.label}
                {isActive && <Check className="size-3.5" />}
              </button>
            )
          })}
        </div>
      </section>

      <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />

      {/* Detected agents */}
      {detectedAgents.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold">Installed</h3>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              {detectedAgents.length} detected
            </span>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Re-read your shell PATH and re-detect installed agents"
              className={cn(
                'ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                isRefreshing
                  ? 'text-muted-foreground/60'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          <div className="space-y-2">
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

      {/* Undetected agents */}
      {undetectedAgents.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-muted-foreground">Available to install</h3>
            <span className="rounded-full border border-border/40 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {undetectedAgents.length} agents
            </span>
          </div>

          <div className="space-y-2">
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
        <div className="flex items-center justify-center rounded-xl border border-dashed border-border/50 py-8 text-sm text-muted-foreground">
          Detecting installed agents…
        </div>
      )}
    </div>
  )
}
