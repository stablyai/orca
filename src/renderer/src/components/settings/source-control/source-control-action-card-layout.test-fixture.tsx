import { useState } from 'react'
import { vi } from 'vitest'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  AiActionId,
  SourceControlActionLaunchPreferences
} from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { SourceControlActionRecipeRow } from './SourceControlActionRecipeRow'
import { TooltipProvider } from '../../ui/tooltip'

const unused = vi.fn()
export function Row({
  agent = 'claude',
  actionId = 'fixChecks',
  dirty = false
}: {
  agent?: TuiAgent
  actionId?: AiActionId
  dirty?: boolean
}) {
  const [draft, setDraft] = useState({ agentArgs: '--saved', commandInputTemplate: 'Do the work' })
  const [preferences, setPreferences] = useState<SourceControlActionLaunchPreferences | undefined>({
    agentId: 'claude',
    model: 'sonnet',
    options: { effort: 'high' },
    permissionMode: 'full-access'
  })
  return (
    <TooltipProvider>
      <SourceControlActionRecipeRow
        actionId={actionId}
        selectedAgent={agent}
        defaultTuiAgent="claude"
        draftValue={draft}
        baseValue={draft}
        isSavingTemplate={false}
        hasUnsavedChanges={dirty}
        launchPreferences={preferences}
        onLaunchPreferencesChange={(_id, value, agentArgs) => {
          setPreferences(value)
          if (agentArgs !== undefined) {
            setDraft({ ...draft, agentArgs })
          }
        }}
        onAgentArgsChange={(_id, agentArgs) => setDraft({ ...draft, agentArgs })}
        onAgentChange={unused}
        onTemplateChange={(_id, commandInputTemplate) =>
          setDraft((draft) => ({ ...draft, commandInputTemplate }))
        }
        onAppendVariable={unused}
        onDiscard={unused}
        onSave={unused}
      />
    </TooltipProvider>
  )
}
