import { useLayoutEffect, useMemo, useRef } from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { shouldUseNativeContextMenu } from '../context-menu/worktree-context-menu-policy'
import { useAgentRowMenuController } from './agent-row-menu-context'
import { AGENT_ROW_MENU_ATTR, AGENT_ROW_PANE_KEY_ATTR } from './agent-row-menu-dom'

type TriggerProps = {
  [AGENT_ROW_MENU_ATTR]?: ''
  [AGENT_ROW_PANE_KEY_ATTR]?: string
  tabIndex?: number
  onPointerDownCapture?: () => void
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void
}

const NO_TRIGGER: TriggerProps = {}

function isMenuKey(event: React.KeyboardEvent): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

/** Agent rows inside a workspace card open their own menu; other surfaces and modes keep the card's. */
export function useAgentRowMenuTrigger(args: {
  agent: DashboardAgentRow
  label: string
  sendTargetStatus: string | undefined
  onActivate: (tabId: string, paneKey: string) => void
}): TriggerProps {
  const controller = useAgentRowMenuController()
  const latest = useRef(args)
  useLayoutEffect(() => {
    latest.current = args
  })
  // A keyboard open is followed by the platform's own contextmenu event; swallow only that one.
  const keyboardOpenedRef = useRef<HTMLElement | null>(null)
  const enabled =
    controller !== null &&
    args.agent.rowSource !== 'subagent' &&
    args.sendTargetStatus === undefined
  return useMemo(() => {
    if (!enabled || !controller) {
      return NO_TRIGGER
    }
    const open = (
      event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
      anchor: 'pointer' | 'row'
    ): void => {
      const { agent, label, onActivate } = latest.current
      controller.open({
        row: agent,
        label,
        element: event.currentTarget,
        event,
        anchor,
        onActivate
      })
    }
    return {
      [AGENT_ROW_MENU_ATTR]: '',
      [AGENT_ROW_PANE_KEY_ATTR]: args.agent.paneKey,
      tabIndex: 0,
      onPointerDownCapture: () => {
        keyboardOpenedRef.current = null
      },
      onContextMenu: (event) => {
        if (shouldUseNativeContextMenu(event.target)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (keyboardOpenedRef.current === event.currentTarget) {
          keyboardOpenedRef.current = null
          return
        }
        open(event, 'pointer')
      },
      onKeyDown: (event) => {
        if (
          event.target !== event.currentTarget ||
          isImeOwnedKeyboardEvent(event.nativeEvent) ||
          !isMenuKey(event)
        ) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        keyboardOpenedRef.current = event.currentTarget
        open(event, 'row')
      }
    }
  }, [enabled, controller, args.agent.paneKey])
}
