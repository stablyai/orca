import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '../../../ui/input'
import {
  agentCopyBase,
  type AgentCopy
} from '../../../../../../shared/agent-launch/catalog/agent-copies'

/** An agent copy's name and ID, at the top of its card; everything else is its agent's editors. */
export function AgentCopyIdentityFields({
  copy,
  taken,
  onChange
}: {
  copy: AgentCopy
  taken: readonly string[]
  onChange: (identity: { name: string; id: string }) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const [name, setName] = useState(copy.name)
  const [id, setId] = useState(copy.id)
  const idProblem =
    agentCopyBase(id) !== copy.agent || !id.startsWith(`${copy.agent}.`)
      ? t(
          'settings.agents.copyIdInvalid',
          'Use {{agent}}. followed by lowercase letters, digits and dashes.',
          { agent: copy.agent }
        )
      : taken.includes(id)
        ? t('settings.agents.copyIdTaken', 'Another copy has this ID.')
        : null
  const commitName = (): void => {
    const trimmed = name.trim()
    if (!trimmed) {
      setName(copy.name)
    } else if (trimmed !== copy.name) {
      void onChange({ name: trimmed, id: copy.id })
    }
  }
  const commitId = (): void => {
    if (!idProblem && id !== copy.id) {
      void onChange({ name: copy.name, id })
    }
  }
  return (
    <div className="flex flex-wrap gap-3">
      <label className="flex min-w-48 flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          {t('settings.agents.copyName', 'Copy name')}
        </span>
        <Input
          value={name}
          aria-label={t('settings.agents.copyName', 'Copy name')}
          className="h-8"
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setName(copy.name)
            }
          }}
        />
      </label>
      <label className="flex min-w-48 flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t('settings.agents.copyId', 'ID')}</span>
        <Input
          value={id}
          aria-label={t('settings.agents.copyIdLabel', 'Copy ID')}
          aria-invalid={idProblem !== null}
          variant="code"
          className="h-8"
          onChange={(event) => setId(event.target.value.trim())}
          onBlur={commitId}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setId(copy.id)
            }
          }}
        />
        {idProblem && <p className="text-[11px] text-destructive">{idProblem}</p>}
      </label>
    </div>
  )
}
