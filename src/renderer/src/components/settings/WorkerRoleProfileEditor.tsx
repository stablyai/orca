import { sayNativeChatSessionOptionTranslated as say } from '../native-chat/native-chat-session-option-labels-text'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  findCatalogModel,
  findCatalogOption
} from '../../../../shared/agent-session-option-catalog'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { WorkerRoleProfile } from '../../../../shared/orchestration-worker-roles'
import { useWorkerRoleModelCatalog } from './use-worker-role-model-catalog'
import { nativeChatSessionChoiceLabel } from '../../../../shared/native-chat-session-option-labels'
import { sayAgentSessionFailureTranslated } from '../native-chat/agent-session-failure-words-text'
import { notSignedInSentence } from '../../../../shared/agent-session-availability-sentences'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

const INHERIT = '_inherit'

export function WorkerRoleProfileEditor({
  role,
  profile,
  disabled,
  disabledAgents,
  detectedIds,
  structuredFast,
  onChange
}: {
  role: string
  profile: WorkerRoleProfile | undefined
  disabled: boolean
  disabledAgents: readonly string[]
  detectedIds: readonly TuiAgent[] | null
  structuredFast: boolean
  onChange: (profile: WorkerRoleProfile | undefined) => void
}): React.JSX.Element {
  const agents = getAgentCatalog().filter(
    (agent) => isTuiAgentEnabled(agent.id, disabledAgents) && detectedIds?.includes(agent.id)
  )
  const agentAvailable = agents.some((agent) => agent.id === profile?.agent)
  const {
    catalog,
    refresh,
    isRefreshing,
    error,
    unavailable: catalogUnavailable
  } = useWorkerRoleModelCatalog(profile?.agent, agentAvailable)
  const unavailable = translate('settings.orchestration.roles.unavailable', 'Unavailable')
  const notListed = translate('settings.orchestration.roles.notListed', 'Not listed')
  const agentLabel =
    agents.find((agent) => agent.id === profile?.agent)?.label ?? profile?.agent ?? ''
  const catalogError = error
    ? translate('settings.orchestration.roles.modelsFailed', 'Could not load models.')
    : catalogUnavailable?.reason === 'cliMissing'
      ? sayAgentSessionFailureTranslated('cliMissing', { agent: agentLabel })
      : catalogUnavailable?.reason === 'notSignedIn'
        ? notSignedInSentence(
            { agentName: agentLabel },
            { kind: 'notSignedIn', account: catalogUnavailable.account },
            sayAgentSessionFailureTranslated
          )
        : null
  const models = catalog?.supportsWorkerLaunchPreferences ? catalog.models : []
  const model = catalog && profile?.model ? findCatalogModel(catalog, profile.model) : undefined
  const effort = findCatalogOption(model, 'effort')
  const fast = findCatalogOption(model, 'fastMode')
  const supportsFast =
    fast?.kind.type === 'boolean' &&
    (fast.apply.launchArgs || fast.apply.composedIntoModel || structuredFast)
  const writeOption = (key: 'model' | 'effort' | 'fastMode', value: string) => {
    if (!profile) {
      return
    }
    const next = { ...profile }
    if (key === 'model') {
      delete next.effort
      delete next.fastMode
    }
    if (value === INHERIT) {
      delete next[key]
    } else if (key === 'fastMode') {
      next.fastMode = value === 'on'
    } else {
      next[key] = value
    }
    onChange(next)
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={`worker-role-${role}-agent`}>
          {translate('settings.orchestration.roles.agent', 'Agent')}
        </Label>
        <Select
          value={profile?.agent ?? INHERIT}
          disabled={disabled}
          onValueChange={(agent) => onChange(agent === INHERIT ? undefined : { agent })}
        >
          <SelectTrigger id={`worker-role-${role}-agent`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {translate('settings.orchestration.roles.unconfigured', 'Not configured')}
            </SelectItem>
            {profile && !agents.some((agent) => agent.id === profile.agent) ? (
              <SelectItem value={profile.agent} disabled>
                {getAgentCatalog().find((agent) => agent.id === profile.agent)?.label ??
                  profile.agent}{' '}
                ·{' '}
                {detectedIds === null
                  ? translate('settings.orchestration.roles.checking', 'Checking…')
                  : unavailable}
              </SelectItem>
            ) : null}
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`worker-role-${role}-model`}>
          {translate('settings.orchestration.roles.model', 'Model')}
        </Label>
        <Select
          value={profile?.model ?? INHERIT}
          disabled={disabled || !profile || !agentAvailable}
          onOpenChange={(open) => {
            if (open) {
              refresh()
            }
          }}
          onValueChange={(value) => writeOption('model', value)}
        >
          <SelectTrigger
            id={`worker-role-${role}-model`}
            aria-describedby={catalogError ? `worker-role-${role}-model-error` : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {translate('settings.orchestration.roles.agentDefault', 'Agent default')}
            </SelectItem>
            {profile?.model && !models.some((candidate) => candidate.id === profile.model) ? (
              <SelectItem value={profile.model} disabled>
                {profile.model} · {notListed}
              </SelectItem>
            ) : null}
            {isRefreshing ? (
              <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
                {translate('settings.orchestration.roles.refreshingModels', 'Refreshing models…')}
              </div>
            ) : null}
            {!isRefreshing && !catalogError && models.length === 0 ? (
              <div role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
                {translate(
                  'settings.orchestration.roles.modelsUnavailable',
                  'No models reported by this host.'
                )}
              </div>
            ) : null}
            {models.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {catalogError ? (
          <div className="space-y-1">
            <p
              id={`worker-role-${role}-model-error`}
              role="status"
              className="text-xs text-muted-foreground"
            >
              {catalogError}
            </p>
            {error ? (
              <details className="max-w-full text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">
                  {translate('settings.orchestration.roles.modelErrorDetails', 'Details')}
                </summary>
                <div className="scrollbar-sleek mt-1 max-h-40 overflow-auto break-words whitespace-pre-wrap">
                  {error}
                </div>
              </details>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled || isRefreshing}
              onClick={refresh}
            >
              {translate('settings.orchestration.roles.retryModels', 'Retry')}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`worker-role-${role}-effort`}>
          {translate('settings.orchestration.roles.effort', 'Reasoning effort')}
        </Label>
        <Select
          value={profile?.effort ?? INHERIT}
          disabled={
            disabled || !agentAvailable || (!profile?.effort && effort?.kind.type !== 'select')
          }
          onValueChange={(value) => writeOption('effort', value)}
        >
          <SelectTrigger id={`worker-role-${role}-effort`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {translate('settings.orchestration.roles.agentDefault', 'Agent default')}
            </SelectItem>
            {profile?.effort &&
            (effort?.kind.type !== 'select' ||
              !effort.kind.choices.some((choice) => choice.value === profile.effort)) ? (
              <SelectItem value={profile.effort} disabled>
                {profile.effort} · {notListed}
              </SelectItem>
            ) : null}
            {effort?.kind.type === 'select'
              ? effort.kind.choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {nativeChatSessionChoiceLabel(choice, say)}
                  </SelectItem>
                ))
              : null}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`worker-role-${role}-fast`}>
          {translate('settings.orchestration.roles.fast', 'Fast')}
        </Label>
        <Select
          value={profile?.fastMode === undefined ? INHERIT : profile.fastMode ? 'on' : 'off'}
          disabled={
            disabled || !agentAvailable || (!supportsFast && profile?.fastMode === undefined)
          }
          onValueChange={(value) => writeOption('fastMode', value)}
        >
          <SelectTrigger id={`worker-role-${role}-fast`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {translate('settings.orchestration.roles.agentDefault', 'Agent default')}
            </SelectItem>
            <SelectItem value="on" disabled={!supportsFast}>
              {translate('settings.orchestration.roles.on', 'On')}
            </SelectItem>
            <SelectItem value="off" disabled={!supportsFast}>
              {translate('settings.orchestration.roles.off', 'Off')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
