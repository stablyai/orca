import { useState } from 'react'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentLaunchSettingsMutation } from '../../../../../../shared/agent-launch/choices/agent-launch-settings'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { useAgentLaunchFieldWrite } from '../../../agent/launch-settings/use-agent-launch-field-write'

export function HostAgentEnvironmentEditor({
  agent,
  names,
  mutate
}: {
  agent: TuiAgent
  names: readonly string[]
  mutate: (mutation: AgentLaunchSettingsMutation) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [newName, setNewName] = useState('')
  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground">
        {t('auto.components.settings.AgentsPane.8fbe1f37c1', 'Environment')}
      </span>
      {names.map((name) => (
        <EnvironmentValueRow key={name} agent={agent} name={name} saved mutate={mutate} />
      ))}
      <div className="flex items-center gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          aria-label={t('settings.agents.environmentName', 'Environment variable name')}
          placeholder={t('settings.agents.environmentName', 'Environment variable name')}
          spellCheck={false}
          className="h-7"
        />
      </div>
      {newName.trim() ? (
        <EnvironmentValueRow
          key={newName.trim()}
          agent={agent}
          name={newName.trim()}
          saved={false}
          mutate={async (mutation) => {
            await mutate(mutation)
            setNewName((current) => (current.trim() === mutation.name ? '' : current))
          }}
        />
      ) : null}
    </div>
  )
}

function EnvironmentValueRow({
  agent,
  name,
  saved,
  mutate
}: {
  agent: TuiAgent
  name: string
  saved: boolean
  mutate: (
    mutation: Extract<
      AgentLaunchSettingsMutation,
      { type: 'environment-set' | 'environment-remove' }
    >
  ) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [changed, setChanged] = useState(false)
  const { pending, write } = useAgentLaunchFieldWrite()
  const save = (): void =>
    write(
      'save',
      () => mutate({ type: 'environment-set', agent, name, value }),
      () => {
        setValue('')
        setChanged(false)
      }
    )
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{name}</span>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={value}
          readOnly={pending}
          onChange={(event) => {
            setValue(event.target.value)
            setChanged(true)
          }}
          aria-label={t('settings.agents.environmentValue', 'Value for {{name}}', { name })}
          placeholder={
            saved
              ? t('settings.agents.savedEnvironment', 'Saved value · enter to replace')
              : t('settings.agents.newEnvironment', 'Value')
          }
          spellCheck={false}
          className="h-7"
        />
        <Button type="button" size="xs" disabled={!changed || pending} onClick={save}>
          {t('settings.agents.save', 'Save')}
        </Button>
        {saved ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={() =>
              write('remove', () => mutate({ type: 'environment-remove', agent, name }))
            }
          >
            {t('settings.agents.removeEnvironment', 'Remove')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
