import { useTranslate } from '../../../../i18n/use-translate'
import type { AgentPermissionChoice } from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { ChevronDown } from 'lucide-react'
import { Button } from '../../../ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup
} from '../../../ui/dropdown-menu'
import {
  AgentPermissionChoiceItems,
  AgentPermissionChoiceName
} from '../../../agent/launch-settings/AgentPermissionChoiceItems'

export function AllAgentsPermissionSetting({
  chatOwnSupported = false,
  choice,
  withoutAutoChoice,
  onChange,
  onChangeWithoutAuto
}: {
  chatOwnSupported?: boolean
  choice: AgentPermissionChoice | null
  /** What the agents without Approve for me share; null when they differ. */
  withoutAutoChoice: AgentPermissionChoice | null
  onChange: (choice: AgentPermissionChoice) => void
  onChangeWithoutAuto: (choice: AgentPermissionChoice) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('settings.agents.permissionsTitle', 'Permissions')
  const ownLabel = t('settings.agents.permissionEachOwn', "Each agent's own settings")
  const withoutAutoTitle = t(
    'settings.agents.otherAgentsPermissionsLabel',
    'Permissions for other agents'
  )
  return (
    <section className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={choice === null}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label={title}
              className="w-48 max-w-full justify-between"
            >
              {choice === null ? (
                <span className="h-4" />
              ) : (
                <AgentPermissionChoiceName choice={choice} ownLabel={ownLabel} truncate />
              )}
              <ChevronDown className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" collisionPadding={8} className="w-72">
            <DropdownMenuRadioGroup aria-label={title} value={choice ?? ''}>
              <AgentPermissionChoiceItems
                choices={['ask', 'auto', 'full-access', 'own']}
                ownLabel={ownLabel}
                chatOwnSupported={chatOwnSupported}
                onSelect={onChange}
              />
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'settings.agents.permissionsChoiceExplanation',
          'What every agent may do without asking. You can set one agent differently below.'
        )}
      </p>
      {choice === 'auto' ? (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-xs text-muted-foreground">
            {t('settings.agents.permissionWithoutAuto', 'Agents without Approve for me')}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label={withoutAutoTitle}
                className="min-w-0 max-w-full"
              >
                {withoutAutoChoice === null ? (
                  <span className="truncate">{t('settings.agents.permissionMixed', 'Mixed')}</span>
                ) : (
                  <AgentPermissionChoiceName
                    choice={withoutAutoChoice}
                    ownLabel={ownLabel}
                    truncate
                  />
                )}
                <ChevronDown className="size-3 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" collisionPadding={8} className="w-72">
              <DropdownMenuRadioGroup aria-label={withoutAutoTitle} value={withoutAutoChoice ?? ''}>
                <AgentPermissionChoiceItems
                  choices={['full-access', 'own']}
                  ownLabel={ownLabel}
                  chatOwnSupported={chatOwnSupported}
                  onSelect={onChangeWithoutAuto}
                />
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </section>
  )
}
