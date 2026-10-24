import { useEffect, useId } from 'react'
import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import type {
  AgentLaunchSettingsMutation,
  AgentPermissionResetEntry
} from '../../../../shared/agent-launch-settings'
import { nativeChatPermissionModeLabel } from '../native-chat/native-chat-permission-mode-labels'

export function useAgentPermissionResetNotice(): (
  resets: readonly AgentPermissionResetEntry[],
  mutation: AgentLaunchSettingsMutation,
  undo?: () => Promise<void>
) => void {
  const id = useId()
  const mounted = useMountedRef()
  useEffect(
    () => () => {
      toast.dismiss(id)
    },
    [id]
  )
  return (resets, mutation, undo) => {
    if (
      !mounted.current ||
      !resets.length ||
      mutation.type !== 'permission' ||
      mutation.choice === 'default'
    ) {
      return
    }
    const mode =
      mutation.choice === 'own'
        ? translate('settings.agents.permissionEachOwn', "Each agent's own settings")
        : nativeChatPermissionModeLabel(mutation.choice)
    toast.success(
      translate('settings.agents.permissionResetMoved', 'Moved {{count}} agents to {{mode}}', {
        count: resets.length,
        mode
      }),
      {
        id,
        description: (
          <div className="text-muted-foreground">
            {resets.slice(0, 3).map(({ agent, previousChoice }) => (
              <div key={agent}>
                <span className="font-normal text-popover-foreground">{getAgentLabel(agent)}</span>
                {' · '}
                {translate('settings.agents.permissionResetWas', 'was {{mode}}', {
                  mode:
                    previousChoice === 'own'
                      ? translate('settings.agents.permissionResetOwn', 'its own settings')
                      : nativeChatPermissionModeLabel(previousChoice)
                })}
              </div>
            ))}
            {resets.length > 3 ? (
              <div>
                {translate('settings.agents.permissionResetMore', 'and {{count}} more', {
                  count: resets.length - 3
                })}
              </div>
            ) : null}
          </div>
        ),
        classNames: {
          content: '!basis-0',
          actionButton: '!m-0 !self-start'
        },
        ...(undo
          ? {
              action: {
                label: translate('settings.agents.permissionResetUndo', 'Undo'),
                onClick: () => {
                  void undo().catch(() => {})
                }
              }
            }
          : {})
      }
    )
  }
}
