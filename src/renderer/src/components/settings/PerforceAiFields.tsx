import {
  CUSTOM_AGENT_ID,
  listCommitMessageAgentCapabilities
} from '../../../../shared/commit-message-agent-spec'
import type { PerforceSettings } from '../../../../shared/perforce/perforce-settings'
import { translate } from '@/i18n/i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow } from './SettingsFormControls'
import { CommitInput, InstructionsField } from './perforce-settings-inputs'

const DEFAULT_CHOICE = '__default__'

export function PerforceAiAgentFields({
  perforce,
  update
}: {
  perforce: PerforceSettings
  update: (patch: Partial<PerforceSettings>) => void
}): React.JSX.Element {
  const agents = listCommitMessageAgentCapabilities()
  const agent = agents.find((candidate) => candidate.id === perforce.aiAgentId)
  const isCustom = perforce.aiAgentId === CUSTOM_AGENT_ID
  const model = agent?.models.find((candidate) => candidate.id === perforce.aiModel)
  const l = (key: string, fallback: string): string =>
    translate(`perforce.settings.ai.${key}`, fallback)
  const choose = (value: string): string => (value === DEFAULT_CHOICE ? '' : value)

  return (
    <div className="space-y-1 border-l border-border/50 pl-4">
      <SettingsRow
        label={l('agent', 'Agent')}
        description={l('agentDescription', 'Runs independently of the Git commit-message agent.')}
        control={
          <Select
            value={perforce.aiAgentId || DEFAULT_CHOICE}
            onValueChange={(value) =>
              update({ aiAgentId: choose(value), aiModel: '', aiThinkingLevel: '' })
            }
          >
            <SelectTrigger aria-label={l('agent', 'Agent')} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_CHOICE}>
                {l('defaultAgent', 'App default agent')}
              </SelectItem>
              {agents.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_AGENT_ID}>
                {l('customCommand', 'Custom command')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {agent && agent.modelSource === 'static' && agent.models.length > 0 ? (
        <SettingsRow
          label={l('model', 'Model')}
          control={
            <Select
              value={perforce.aiModel || DEFAULT_CHOICE}
              onValueChange={(value) => update({ aiModel: choose(value), aiThinkingLevel: '' })}
            >
              <SelectTrigger aria-label={l('model', 'Model')} className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_CHOICE}>{l('defaultModel', 'Default model')}</SelectItem>
                {agent.models.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      ) : null}
      {agent && agent.modelSource === 'dynamic' ? (
        <SettingsRow
          label={l('model', 'Model')}
          description={l(
            'modelDescription',
            'Model id passed to the agent. Leave empty for its default.'
          )}
          control={
            <CommitInput
              value={perforce.aiModel}
              ariaLabel={l('model', 'Model')}
              placeholder={agent.defaultModelId}
              className="w-56"
              onCommit={(aiModel) => update({ aiModel, aiThinkingLevel: '' })}
            />
          }
        />
      ) : null}
      {model?.thinkingLevels?.length ? (
        <SettingsRow
          label={l('thinking', 'Thinking level')}
          control={
            <Select
              value={perforce.aiThinkingLevel || DEFAULT_CHOICE}
              onValueChange={(value) => update({ aiThinkingLevel: choose(value) })}
            >
              <SelectTrigger aria-label={l('thinking', 'Thinking level')} className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_CHOICE}>{l('defaultThinking', 'Default')}</SelectItem>
                {model.thinkingLevels.map((level) => (
                  <SelectItem key={level.id} value={level.id}>
                    {level.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      ) : null}
      {isCustom ? (
        <SettingsRow
          label={l('command', 'Command')}
          description={l(
            'commandDescription',
            'Shell command that reads the prompt and prints the description.'
          )}
          control={
            <CommitInput
              value={perforce.aiCustomCommand}
              ariaLabel={l('command', 'Command')}
              className="w-72"
              onCommit={(aiCustomCommand) => update({ aiCustomCommand })}
            />
          }
        />
      ) : null}
      <SettingsRow
        label={l('args', 'Extra CLI arguments')}
        control={
          <CommitInput
            value={perforce.aiAgentArgs}
            ariaLabel={l('args', 'Extra CLI arguments')}
            className="w-72"
            onCommit={(aiAgentArgs) => update({ aiAgentArgs })}
          />
        }
      />
      <InstructionsField
        value={perforce.aiInstructions}
        onCommit={(aiInstructions) => update({ aiInstructions })}
      />
    </div>
  )
}
