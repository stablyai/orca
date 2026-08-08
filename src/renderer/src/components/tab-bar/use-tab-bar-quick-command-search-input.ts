import { useCallback, type KeyboardEvent, type RefObject } from 'react'

import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import type { TerminalQuickCommand } from '../../../../shared/types'

type SearchInputOptions = {
  commandListRef: RefObject<HTMLDivElement | null>
  commandValue: string
  filteredCommands: readonly TerminalQuickCommand[]
  onCommandValueChange: (commandId: string) => void
  onRun: (command: TerminalQuickCommand) => void
  selectedCommand: TerminalQuickCommand | null
}

export function useTabBarQuickCommandSearchInput({
  commandListRef,
  commandValue,
  filteredCommands,
  onCommandValueChange,
  onRun,
  selectedCommand
}: SearchInputOptions): {
  onBlur: () => void
  onCompositionEnd: () => void
  onCompositionStart: () => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onKeyUp: ReturnType<typeof useImeEnterGestureOwnership>['onKeyUp']
} {
  const imeEnter = useImeEnterGestureOwnership()
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (imeEnter.ownsKeyDown(event)) {
        return
      }
      if (event.key === 'Enter' && selectedCommand) {
        event.preventDefault()
        event.stopPropagation()
        onRun(selectedCommand)
        return
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && filteredCommands.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        const currentIndex = filteredCommands.findIndex((command) => command.id === commandValue)
        const startIndex = Math.max(currentIndex, 0)
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex =
          (startIndex + direction + filteredCommands.length) % filteredCommands.length
        onCommandValueChange(filteredCommands[nextIndex].id)
        requestAnimationFrame(() => {
          commandListRef.current
            ?.querySelector('[cmdk-item][data-selected="true"]')
            ?.scrollIntoView({ block: 'nearest' })
        })
        return
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.stopPropagation()
      }
    },
    [
      commandListRef,
      commandValue,
      filteredCommands,
      imeEnter,
      onCommandValueChange,
      onRun,
      selectedCommand
    ]
  )

  return {
    onBlur: imeEnter.reset,
    onCompositionEnd: () => imeEnter.setComposing(false),
    onCompositionStart: () => imeEnter.setComposing(true),
    onKeyDown,
    onKeyUp: imeEnter.onKeyUp
  }
}
