// The default model of a custom ACP agent: one of the models it reported, or an id typed in.

import { RefreshCw } from 'lucide-react'
import type { CustomAcpAgentId } from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { useCustomAcpAgentModels, type CustomAcpAgentModels } from './use-custom-acp-agent-models'

// Radix Select gives no item an empty value, so the agent's own default has a placeholder value.
const AGENT_DEFAULT = '__agent-default__'

function problemText(problem: CustomAcpAgentModels['problem'], t: Translate): string {
  if (problem === 'notSignedIn') {
    return t('settings.agents.customAcp.models.notSignedIn', 'The agent needs to be signed in.')
  }
  if (problem === 'cliMissing' || problem === 'agentCommandNotRunnable') {
    return t('settings.agents.customAcp.models.commandMissing', 'Orca could not run the command.')
  }
  return t(
    'settings.agents.customAcp.models.failed',
    "The agent didn't report any models. You can still type a model id."
  )
}

export function CustomAcpAgentModelField({
  agent,
  value,
  onChange,
  idPrefix,
  invalid = false
}: {
  /** Undefined until the agent is saved: the host can only list a saved agent's models. */
  agent: CustomAcpAgentId | undefined
  value: string
  onChange: (model: string) => void
  idPrefix: string
  /** The typed id is too long to save. */
  invalid?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { models, state, problem, refresh } = useCustomAcpAgentModels(agent)
  const listed = models.some(({ id }) => id === value)
  return (
    <div className="space-y-1">
      <Label htmlFor={`${idPrefix}-model`}>
        {t('settings.agents.customAcp.models.label', 'Default model')}
      </Label>
      <p className="text-xs text-muted-foreground">
        {agent
          ? t(
              'settings.agents.customAcp.models.description',
              'New chats start on this model. Refresh starts the agent once in a private folder to list its models.'
            )
          : t(
              'settings.agents.customAcp.models.saveFirst',
              'Save the agent to list its models. You can type a model id now.'
            )}
      </p>
      <div className="flex items-center gap-2">
        <Select
          value={value || AGENT_DEFAULT}
          onValueChange={(next) => onChange(next === AGENT_DEFAULT ? '' : next)}
        >
          <SelectTrigger id={`${idPrefix}-model`} size="sm" className="min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AGENT_DEFAULT}>
              {t('settings.agents.customAcp.models.agentDefault', "Agent's own default")}
            </SelectItem>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label === model.id ? model.id : `${model.label} · ${model.id}`}
              </SelectItem>
            ))}
            {value && !listed ? <SelectItem value={value}>{value}</SelectItem> : null}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!agent || state === 'listing'}
          onClick={refresh}
        >
          <RefreshCw className={state === 'listing' ? 'animate-spin' : undefined} />
          {state === 'listing'
            ? t('settings.agents.customAcp.models.listing', 'Listing…')
            : t('settings.agents.customAcp.models.refresh', 'Refresh')}
        </Button>
      </div>
      {state === 'failed' ? (
        <p className="text-xs text-muted-foreground">{problemText(problem, t)}</p>
      ) : null}
      <Input
        variant="code"
        value={value}
        aria-invalid={invalid}
        spellCheck={false}
        placeholder={t('settings.agents.customAcp.models.idPlaceholder', 'Or type a model id')}
        aria-label={t('settings.agents.customAcp.models.idLabel', 'Default model id')}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
