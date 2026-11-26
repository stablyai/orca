// New-tab menu rows for the custom ACP agents the workspace's host defines; they open only chats.

import React, { useCallback } from 'react'
import { Bot } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { launchCustomAcpAgentChat } from '@/lib/agent-session/launch/new-tab/launch-custom-acp-agent-chat'
import type { CustomAcpAgentMenuRow } from './new-tab-agent-menu-model'

export type CustomAcpAgentLaunchTarget = {
  worktreeId: string
  groupId: string
  /** A chat opened at once: its composer takes the focus the menu gives back. */
  onFocusChat?: (tabId: string) => void
}

function useCustomAcpAgentMenuLaunch(
  { worktreeId, groupId, onFocusChat }: CustomAcpAgentLaunchTarget,
  disabled: boolean
): (row: CustomAcpAgentMenuRow) => boolean {
  return useCallback(
    (row: CustomAcpAgentMenuRow) => {
      if (disabled || row.missing) {
        return false
      }
      const result = launchCustomAcpAgentChat({
        agent: row.agent,
        worktreeId,
        groupId,
        executionHostId: row.executionHostId,
        focusIntent: captureNativeChatComposerFocusIntent()
      })
      if (!result || 'refused' in result) {
        return false
      }
      if (result.surface.kind === 'local-chat') {
        onFocusChat?.(result.surface.tabId)
      }
      return true
    },
    [worktreeId, groupId, onFocusChat, disabled]
  )
}

export function CustomAcpAgentMenuItems({
  rows,
  disabled,
  target
}: {
  rows: readonly CustomAcpAgentMenuRow[]
  disabled: boolean
  target: CustomAcpAgentLaunchTarget
}): React.JSX.Element {
  const t = useTranslate()
  const launch = useCustomAcpAgentMenuLaunch(target, disabled)
  return (
    <>
      <DropdownMenuSeparator />
      {rows.map((row) => (
        <DropdownMenuItem
          key={row.agent}
          variant="launch"
          disabled={disabled || row.missing === true}
          onSelect={(event) => {
            if (!launch(row)) {
              event.preventDefault()
            }
          }}
          title={t('agentMenu.customAcpAgent.title', 'Open a {{value0}} chat', {
            value0: row.label
          })}
        >
          <Bot size={14} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <span className="text-xs text-muted-foreground">
            {row.missing
              ? t('agentMenu.customAcpAgent.missing', 'Command not found')
              : t('agentMenu.customAcpAgent.badge', 'ACP')}
          </span>
        </DropdownMenuItem>
      ))}
    </>
  )
}
