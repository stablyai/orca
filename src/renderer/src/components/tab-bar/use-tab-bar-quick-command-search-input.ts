import { useCallback, type KeyboardEvent, type RefObject } from 'react'

import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'

type SearchInputOptions<TCommand> = {
  commandListRef: RefObject<HTMLDivElement | null>
  commandValue: string
  filteredCommands: readonly TCommand[]
  getCommandId: (command: TCommand) => string
  onCommandValueChange: (commandId: string) => void
  onRun: (command: TCommand) => void
  selectedCommand: TCommand | null
}

export function useTabBarQuickCommandSearchInput<TCommand>({
  commandListRef,
  commandValue,
  filteredCommands,
  getCommandId,
  onCommandValueChange,
  onRun,
  selectedCommand
}: SearchInputOptions<TCommand>): {
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
        const currentIndex = filteredCommands.findIndex(
          (command) => getCommandId(command) === commandValue
        )
        const startIndex = Math.max(currentIndex, 0)
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex =
          (startIndex + direction + filteredCommands.length) % filteredCommands.length
        onCommandValueChange(getCommandId(filteredCommands[nextIndex]))
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
      getCommandId,
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
