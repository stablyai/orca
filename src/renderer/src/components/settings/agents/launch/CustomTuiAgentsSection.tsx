import { useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import {
  MAX_CUSTOM_TUI_AGENTS,
  type CustomTuiAgent
} from '../../../../../../shared/agent-launch/catalog/custom-tui-agents'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { SettingsBadge } from '../../form-controls/SettingsFormControls'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { CustomTuiAgentDialog } from './CustomTuiAgentDialog'

type Editing = { mode: 'add' | 'edit'; agent: CustomTuiAgent }

export function CustomTuiAgentsSection({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const customAgents = settings.customTuiAgents ?? []
  const [editing, setEditing] = useState<Editing | null>(null)
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null)

  const save = (next: CustomTuiAgent[]): void => {
    void updateSettings({ customTuiAgents: next })
  }

  const upsert = (agent: CustomTuiAgent): void => {
    const exists = customAgents.some((entry) => entry.id === agent.id)
    save(
      exists
        ? customAgents.map((entry) => (entry.id === agent.id ? agent : entry))
        : [...customAgents, agent]
    )
    setEditing(null)
  }

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= customAgents.length) {
      return
    }
    const next = [...customAgents]
    const [moved] = next.splice(index, 1)
    if (!moved) {
      return
    }
    next.splice(target, 0, moved)
    save(next)
  }

  return (
    <>
      <SettingsGroup
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t('settings.agents.customAgents.title', 'Custom agents')}
            {customAgents.length > 0 ? (
              <SettingsBadge tone="muted">{customAgents.length}</SettingsBadge>
            ) : null}
          </span>
        }
        description={t(
          'settings.agents.customAgents.description',
          'Extra entries for an installed agent that start it with your own command, such as a wrapper. Status, prompts and resume work as usual; pick them from the + menu.'
        )}
        action={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={customAgents.length >= MAX_CUSTOM_TUI_AGENTS}
            className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() =>
              setEditing({
                mode: 'add',
                agent: {
                  id: `custom-agent-${createNonSecureContextUuid()}`,
                  name: '',
                  agent: 'claude',
                  command: ''
                }
              })
            }
          >
            <Plus className="size-3" />
            {t('settings.agents.customAgents.add', 'Add')}
          </Button>
        }
      >
        {customAgents.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground">
            {t(
              'settings.agents.customAgents.empty',
              'No custom agents yet. Add one to start Claude or another agent with your own command.'
            )}
          </div>
        ) : (
          customAgents.map((agent, index) => (
            <div key={agent.id} data-settings-row="" className="flex items-center gap-3 py-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
                <AgentIcon agent={agent.agent} size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium leading-none">{agent.name}</span>
                  <SettingsBadge tone="muted">{getAgentLabel(agent.agent)}</SettingsBadge>
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {agent.command}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <RowAction
                  label={t('settings.agents.customAgents.moveUp', 'Move up')}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </RowAction>
                <RowAction
                  label={t('settings.agents.customAgents.moveDown', 'Move down')}
                  disabled={index === customAgents.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </RowAction>
                <RowAction
                  label={t('settings.agents.customAgents.edit', 'Edit')}
                  onClick={() => setEditing({ mode: 'edit', agent })}
                >
                  <Pencil className="size-3.5" />
                </RowAction>
                {armedDeleteId === agent.id ? (
                  <Button
                    type="button"
                    variant="destructive-chip"
                    size="xs"
                    autoFocus
                    onBlur={() => setArmedDeleteId(null)}
                    onKeyDown={(event) => event.key === 'Escape' && setArmedDeleteId(null)}
                    onClick={() => {
                      setArmedDeleteId(null)
                      save(customAgents.filter((entry) => entry.id !== agent.id))
                    }}
                  >
                    {t('settings.agents.customAgents.confirmDelete', 'Delete')}
                  </Button>
                ) : (
                  <RowAction
                    label={t('settings.agents.customAgents.delete', 'Delete {{name}}', {
                      name: agent.name
                    })}
                    onClick={() => setArmedDeleteId(agent.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </RowAction>
                )}
              </div>
            </div>
          ))
        )}
      </SettingsGroup>
      {editing ? (
        <CustomTuiAgentDialog
          key={editing.agent.id}
          mode={editing.mode}
          initial={editing.agent}
          settingsCommands={settings.agentCmdOverrides}
          onOpenChange={(open) => !open && setEditing(null)}
          onSave={upsert}
        />
      ) : null}
    </>
  )
}

function RowAction({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
