import { useEffect, useId, useRef } from 'react'
import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import {
  agentPermissionChoices,
  PERMISSION_CHOICE_AGENTS,
  type AgentPermissionChoice
} from '../../../../shared/tui-agent-permission-choice'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { nativeChatPermissionModeLabel } from '../native-chat/native-chat-permission-mode-labels'

type Permissions =
  | Pick<NonNullable<AgentLaunchSettings['agentPermission']>, 'default' | 'overrides'>
  | undefined
export type SelectPermissionOverrides = (current: Permissions) => TuiAgent[]

function modeLabel(choice: AgentPermissionChoice): string {
  return choice === 'own'
    ? translate('settings.agents.permissionEachOwn', "Each agent's own settings")
    : nativeChatPermissionModeLabel(choice)
}

export function useAgentPermissionOverrideNotice() {
  const id = useId()
  const mounted = useMountedRef()
  const active = useRef<Permissions>(undefined)
  const dismiss = () => {
    active.current = undefined
    toast.dismiss(id)
  }
  useEffect(
    () => () => {
      active.current = undefined
      toast.dismiss(id)
    },
    [id]
  )
  return (
    before: Permissions,
    after: Permissions,
    mutation: AgentLaunchSettingsMutation,
    follow: (select: SelectPermissionOverrides) => Promise<void>
  ): void => {
    const global =
      mutation.type === 'permission' &&
      !mutation.agent &&
      !mutation.withoutAuto &&
      mutation.choice !== 'default'
    if (!global) {
      if (
        active.current &&
        (before?.default !== after?.default ||
          JSON.stringify(before?.overrides) !== JSON.stringify(after?.overrides))
      ) {
        dismiss()
      }
      return
    }
    if (!mounted.current || !after) {
      dismiss()
      return
    }
    const retained = PERMISSION_CHOICE_AGENTS.filter((agent) => {
      const choice = after.overrides[agent]
      return (
        choice !== undefined &&
        choice !== after.default &&
        (after.default !== 'auto' || agentPermissionChoices(agent).includes('auto'))
      )
    })
    const vanished = PERMISSION_CHOICE_AGENTS.filter(
      (agent) => before?.overrides[agent] !== undefined && after.overrides[agent] === undefined
    )
    if (!retained.length && !vanished.length) {
      dismiss()
      return
    }
    active.current = after
    const mode = modeLabel(after.default)
    const select: SelectPermissionOverrides = (current) =>
      mounted.current && active.current === after && current?.default === after.default
        ? retained.filter((agent) => current.overrides[agent] === after.overrides[agent])
        : []
    const more = (count: number) =>
      count > 3 ? (
        <div>
          {translate('settings.agents.permissionOverrideMore', 'and {{count}} more', {
            count: count - 3
          })}
        </div>
      ) : null
    toast.success(
      retained.length
        ? translate(
            'settings.agents.permissionOverridesKept',
            '{{count}} agents still use their own permission setting:',
            {
              count: retained.length,
              defaultValue_one: '{{count}} agent still uses their own permission setting:'
            }
          )
        : translate(
            'settings.agents.permissionOverridesFollow',
            '{{count}} agents now follow {{mode}}',
            {
              count: vanished.length,
              mode,
              defaultValue_one: '{{count}} agent now follows {{mode}}'
            }
          ),
      {
        id,
        description: (
          <div className="text-muted-foreground">
            {retained.slice(0, 3).map((agent) => (
              <div key={agent}>
                <span className="font-normal text-popover-foreground">{getAgentLabel(agent)}</span>
                {' · '}
                {modeLabel(after.overrides[agent] ?? after.default)}
              </div>
            ))}
            {more(retained.length)}
            {vanished.slice(0, 3).map((agent) => (
              <div key={agent}>
                {translate(
                  'settings.agents.permissionOverrideFollows',
                  '{{agent}} now follows {{mode}}',
                  { agent: getAgentLabel(agent), mode }
                )}
              </div>
            ))}
            {more(vanished.length)}
          </div>
        ),
        classNames: { content: '!basis-0', actionButton: '!m-0 !self-start' },
        ...(retained.length
          ? {
              action: {
                label: translate('settings.agents.permissionOverridesUse', 'Use {{mode}}', {
                  mode
                }),
                onClick: () => {
                  void Promise.resolve(select(after).length ? follow(select) : undefined)
                    .catch(() => {})
                    .finally(() => {
                      if (active.current === after) {
                        dismiss()
                      }
                    })
                }
              }
            }
          : {})
      }
    )
  }
}
