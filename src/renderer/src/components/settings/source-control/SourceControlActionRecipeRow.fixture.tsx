import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SourceControlActionRecipeRow } from './SourceControlActionRecipeRow'
import type { SourceControlActionLaunchPreferences } from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'

function Row(): React.JSX.Element {
  const [draft, setDraft] = useState({
    agentArgs: '--add-dir docs',
    commandInputTemplate: 'Fix the failing checks on this branch.'
  })
  const [preferences, setPreferences] = useState<SourceControlActionLaunchPreferences | undefined>({
    agentId: 'claude',
    model: 'sonnet',
    options: { effort: 'high' },
    permissionMode: 'full-access'
  })
  return (
    <div className="bg-background p-4">
      <SourceControlActionRecipeRow
        actionId="fixChecks"
        selectedAgent="claude"
        defaultTuiAgent="claude"
        draftValue={draft}
        baseValue={draft}
        isSavingTemplate={false}
        hasUnsavedChanges={false}
        launchPreferences={preferences}
        onLaunchPreferencesChange={(_id, value, agentArgs) => {
          setPreferences(value)
          if (agentArgs !== undefined) {
            setDraft((current) => ({ ...current, agentArgs }))
          }
        }}
        onAgentArgsChange={(_id, agentArgs) => setDraft((current) => ({ ...current, agentArgs }))}
        onAgentChange={() => {}}
        onTemplateChange={(_id, commandInputTemplate) =>
          setDraft((current) => ({ ...current, commandInputTemplate }))
        }
        onAppendVariable={() => {}}
        onDiscard={() => {}}
        onSave={() => {}}
      />
    </div>
  )
}

/** A recipe that starts an agent: Permissions and Arguments under its agent picker. */
export const launchRecipeFields = defineFixture({
  width: 720,
  store: { localDetectedAgentIdsByContext: { host: ['claude', 'codex'] } },
  render: () => <Row />,
  interact: () => new Promise((resolve) => setTimeout(resolve, 300))
})
