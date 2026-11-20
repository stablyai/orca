import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { SettingsBadge } from '../../form-controls/SettingsFormControls'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import {
  AgentCommandOverrideInput,
  AgentDefaultArgsInput,
  AgentDefaultEnvInput
} from '../../../agent/launch-settings/AgentLaunchDefaultsEditor'
import {
  agentCopyBase,
  createAgentCopy,
  normalizeAgentCopies,
  type AgentCopy
} from '../../../../../../shared/agent-launch/catalog/agent-copies'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv
} from '../../../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import type { AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'

export type AgentCopyBaseFacts = {
  label: string
  defaultCmd: string
  defaultArgs: string
  defaultEnv: Record<string, string>
}

/** This computer's agent copies; copies keep local environments, so a paired host's page has none. */
export function useAgentCopies(
  local:
    | {
        settings: GlobalSettings
        updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
      }
    | undefined,
  catalog: readonly AgentCatalogEntry[],
  typedPermissions: boolean
) {
  const t = useTranslate()
  const list = local ? normalizeAgentCopies(local.settings.agentCopies) : []
  const save = (copies: AgentCopy[]): void | Promise<void> =>
    local?.updateSettings({ agentCopies: copies })
  const duplicate = (agent: AgentCatalogEntry): void => {
    if (!local) {
      return
    }
    const name = t('settings.agents.copyDefaultName', '{{agent}} copy', { agent: agent.label })
    const copy = createAgentCopy(agent.id, name, local.settings)
    void Promise.resolve(save([...list, copy])).then(() =>
      toast.success(
        t('settings.agents.copyCreated', 'Saved {{name}} as {{id}}.', {
          name: copy.name,
          id: copy.id
        })
      )
    )
  }
  const base = (id: TuiAgent): AgentCopyBaseFacts => {
    const entry = catalog.find((agent) => agent.id === id)
    return {
      label: entry?.label ?? id,
      defaultCmd: entry?.cmd ?? id,
      defaultArgs: typedPermissions ? '' : getTuiAgentDefaultArgs(id),
      defaultEnv: typedPermissions ? {} : getTuiAgentDefaultEnv(id)
    }
  }
  return { list, save, duplicate, base }
}

/** Named copies of installed agents: each starts its base agent's CLI with its own launch setup. */
export function AgentCopiesSection({
  copies,
  base,
  onSave
}: {
  copies: readonly AgentCopy[]
  base: (agent: TuiAgent) => AgentCopyBaseFacts
  onSave: (copies: AgentCopy[]) => void | Promise<void>
}): React.JSX.Element | null {
  const t = useTranslate()
  if (copies.length === 0) {
    return null
  }
  const update = (id: string, next: AgentCopy | null): void | Promise<void> =>
    onSave(copies.flatMap((copy) => (copy.id !== id ? [copy] : next ? [next] : [])))
  return (
    <SettingsGroup
      title={t('settings.agents.copiesTitle', 'Agent copies')}
      description={t(
        'settings.agents.copiesDescription',
        'Each copy runs its agent with its own command, arguments and environment. Pick it by name wherever you start an agent, or pass its ID to --agent.'
      )}
    >
      {copies.map((copy) => (
        <AgentCopyRow
          key={copy.id}
          copy={copy}
          base={base(copy.agent)}
          taken={copies.filter((other) => other.id !== copy.id).map((other) => other.id)}
          onChange={(next) => update(copy.id, next)}
          onDelete={() => update(copy.id, null)}
        />
      ))}
    </SettingsGroup>
  )
}

function AgentCopyRow({
  copy,
  base,
  taken,
  onChange,
  onDelete
}: {
  copy: AgentCopy
  base: AgentCopyBaseFacts
  taken: readonly string[]
  onChange: (next: AgentCopy) => void | Promise<void>
  onDelete: () => void | Promise<void>
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
      void onChange({ ...copy, name: trimmed })
    }
  }
  const commitId = (): void => {
    if (idProblem) {
      return
    }
    if (id !== copy.id) {
      void onChange({ ...copy, id })
    }
  }
  return (
    <div data-settings-row="" className="space-y-3 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          <AgentIcon agent={copy.agent} size={16} />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Input
            value={name}
            aria-label={t('settings.agents.copyName', 'Copy name')}
            className="h-8 max-w-64"
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
          <SettingsBadge>
            {t('settings.agents.copyOf', 'Copy of {{agent}}', { agent: base.label })}
          </SettingsBadge>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('settings.agents.deleteCopy', 'Delete {{name}}', { name: copy.name })}
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => void onDelete()}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-2 pl-10">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t('settings.agents.copyId', 'ID')}</span>
          <Input
            value={id}
            aria-invalid={idProblem !== null}
            variant="code"
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
        </div>
        <AgentCommandOverrideInput
          key={copy.command ?? base.defaultCmd}
          defaultCmd={base.defaultCmd}
          cmdOverride={copy.command}
          onSaveOverride={(value) => {
            const { command: _command, ...rest } = copy
            return onChange(value ? { ...rest, command: value } : rest)
          }}
        />
        <AgentDefaultArgsInput
          key={`${copy.id}:args`}
          defaultArgs={base.defaultArgs}
          argsOverride={copy.args ?? base.defaultArgs}
          onSaveArgs={(value) => onChange({ ...copy, args: value })}
        />
        <AgentDefaultEnvInput
          key={`${copy.id}:env`}
          defaultEnv={base.defaultEnv}
          envOverride={copy.env ?? base.defaultEnv}
          onSaveEnv={(value) => onChange({ ...copy, env: value })}
        />
      </div>
    </div>
  )
}
