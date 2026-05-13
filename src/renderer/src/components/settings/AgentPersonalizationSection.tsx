import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'

type AgentPersonalizationSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  detectedAgents: AgentCatalogEntry[]
}

export function AgentPersonalizationSection({
  settings,
  updateSettings,
  detectedAgents
}: AgentPersonalizationSectionProps): React.JSX.Element {
  const personalizationMode = settings.personalizationPromptMode ?? 'global'
  const personalizationPrompts = settings.agentPersonalizationPrompts ?? {}
  const useSamePersonalization = personalizationMode === 'global'

  const saveAgentPersonalization = (id: TuiAgent, value: string): void => {
    const next = { ...personalizationPrompts }
    const trimmed = value.trim()
    if (trimmed) {
      next[id] = trimmed
    } else {
      delete next[id]
    }
    updateSettings({ agentPersonalizationPrompts: next })
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Custom Instructions</h3>
        <p className="text-xs text-muted-foreground">
          Prepend instructions to agent task prompts and Orca orchestration dispatches. Stored
          locally and may appear in terminal launch surfaces; do not include secrets.
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-border/50 bg-card/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Use the same prompt for every agent</p>
            <p className="text-xs text-muted-foreground">
              Turn this off to customize prompts for individual detected agents.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={useSamePersonalization}
            onClick={() =>
              updateSettings({
                personalizationPromptMode: useSamePersonalization ? 'per-agent' : 'global'
              })
            }
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
              useSamePersonalization ? 'bg-foreground' : 'bg-muted-foreground/30'
            )}
          >
            <span
              className={cn(
                'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
                useSamePersonalization ? 'translate-x-4' : 'translate-x-0.5'
              )}
            />
          </button>
        </div>

        <textarea
          value={settings.personalizationPrompt}
          onChange={(e) => updateSettings({ personalizationPrompt: e.target.value })}
          placeholder="Example: Keep changes small, add tests for behavior changes, and call out security-sensitive assumptions."
          rows={5}
          className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />

        {!useSamePersonalization ? (
          <div className="space-y-3 border-t border-border/50 pt-3">
            <p className="text-xs text-muted-foreground">
              Blank agent prompts use the shared prompt above.
            </p>
            {detectedAgents.length > 0 ? (
              detectedAgents.map((agent) => (
                <div key={agent.id} className="space-y-2 rounded-lg border border-border/40 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <AgentIcon agent={agent.id} size={14} />
                    {agent.label}
                  </div>
                  <textarea
                    value={personalizationPrompts[agent.id] ?? ''}
                    onChange={(e) => saveAgentPersonalization(agent.id, e.target.value)}
                    placeholder="Leave blank to use the shared prompt."
                    rows={3}
                    className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">
                Refresh agent detection to customize per-agent prompts.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  )
}
