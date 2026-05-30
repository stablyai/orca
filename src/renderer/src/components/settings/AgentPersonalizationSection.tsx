import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import {
  normalizePersonalizationPrompt,
  PERSONALIZATION_PROMPT_MAX_CHARS
} from '../../../../shared/agent-personalization'
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { Label } from '../ui/label'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'

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
  const idBase = 'agent-personalization'
  const personalizationMode = settings.personalizationPromptMode ?? 'global'
  const personalizationPrompts = settings.agentPersonalizationPrompts ?? {}
  const useSamePersonalization = personalizationMode === 'global'
  const sharedPromptId = `${idBase}-shared`
  const sharedPromptDescriptionId = `${idBase}-shared-description`
  const sharedPromptCountId = `${idBase}-shared-count`

  const saveAgentPersonalization = (id: TuiAgent, value: string): void => {
    const next = { ...personalizationPrompts }
    const trimmed = normalizePersonalizationPrompt(value)
    if (trimmed) {
      next[id] = trimmed
    } else {
      delete next[id]
    }
    updateSettings({ agentPersonalizationPrompts: next })
  }

  const saveSharedPersonalization = (value: string): void => {
    updateSettings({
      personalizationPrompt: value.slice(0, PERSONALIZATION_PROMPT_MAX_CHARS)
    })
  }

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title="Custom Instructions"
        description="Prepended to agent task prompts and Orca orchestration dispatches. Stored locally and may appear in terminal launch surfaces; do not include secrets."
      />

      <div className="space-y-3 rounded-md border border-border/50 bg-card/50 p-4">
        <SettingsSwitchRow
          label="Use the same prompt for every agent"
          description="Turn this off to customize prompts for individual detected agents."
          checked={useSamePersonalization}
          onChange={() =>
            updateSettings({
              personalizationPromptMode: useSamePersonalization ? 'per-agent' : 'global'
            })
          }
        />

        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor={sharedPromptId}>Shared prompt</Label>
            <p id={sharedPromptDescriptionId} className="text-xs text-muted-foreground">
              Used when per-agent prompts are blank.
            </p>
          </div>
          <textarea
            id={sharedPromptId}
            value={settings.personalizationPrompt}
            onChange={(e) => saveSharedPersonalization(e.target.value)}
            placeholder="Example: Keep changes small, add tests for behavior changes, and call out security-sensitive assumptions."
            rows={5}
            maxLength={PERSONALIZATION_PROMPT_MAX_CHARS}
            aria-describedby={`${sharedPromptDescriptionId} ${sharedPromptCountId}`}
            className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          <p id={sharedPromptCountId} className="text-[11px] text-muted-foreground">
            {settings.personalizationPrompt.length}/{PERSONALIZATION_PROMPT_MAX_CHARS}
          </p>
        </div>

        {!useSamePersonalization ? (
          <div className="space-y-3 border-t border-border/50 pt-3">
            <p className="text-xs text-muted-foreground">
              Blank agent prompts use the shared prompt above.
            </p>
            {detectedAgents.length > 0 ? (
              detectedAgents.map((agent) => {
                const promptId = `${idBase}-${agent.id}-prompt`
                const promptCountId = `${idBase}-${agent.id}-count`
                const value = personalizationPrompts[agent.id] ?? ''
                return (
                  <div key={agent.id} className="space-y-2 rounded-md border border-border/40 p-3">
                    <Label htmlFor={promptId} className="flex items-center gap-2 text-sm">
                      <AgentIcon agent={agent.id} size={14} />
                      {agent.label}
                    </Label>
                    <textarea
                      id={promptId}
                      value={value}
                      onChange={(e) => saveAgentPersonalization(agent.id, e.target.value)}
                      placeholder="Leave blank to use the shared prompt."
                      rows={3}
                      maxLength={PERSONALIZATION_PROMPT_MAX_CHARS}
                      aria-describedby={promptCountId}
                      className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                    <p id={promptCountId} className="text-[11px] text-muted-foreground">
                      {value.length}/{PERSONALIZATION_PROMPT_MAX_CHARS}
                    </p>
                  </div>
                )
              })
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
