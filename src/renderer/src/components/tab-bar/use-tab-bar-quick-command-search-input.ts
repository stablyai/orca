import { useCallback, type KeyboardEvent, type RefObject } from 'react'

import { isSelectAllShortcut } from '@/lib/editable-target'

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
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
} {
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (isSelectAllShortcut(event)) {
        event.stopPropagation()
        return
      }
      if (event.key === 'Enter' && selectedCommand) {
        event.preventDefault()
        event.stopPropagation()
        onRun(selectedCommand)
        return
      }
      const moveDown =
        event.key === 'ArrowDown' || (event.ctrlKey && ['n', 'j'].includes(event.key))
      const moveUp = event.key === 'ArrowUp' || (event.ctrlKey && ['p', 'k'].includes(event.key))
      if (
        (moveDown || moveUp || event.key === 'Home' || event.key === 'End') &&
        filteredCommands.length > 0
      ) {
        event.preventDefault()
        event.stopPropagation()
        const currentIndex = filteredCommands.findIndex(
          (command) => getCommandId(command) === commandValue
        )
        const startIndex = Math.max(currentIndex, 0)
        const direction = moveDown ? 1 : -1
        const nextIndex =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? filteredCommands.length - 1
              : (startIndex + direction + filteredCommands.length) % filteredCommands.length
        onCommandValueChange(getCommandId(filteredCommands[nextIndex]))
        requestAnimationFrame(() => {
          commandListRef.current
            ?.querySelector('[role="option"][aria-selected="true"]')
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
      onCommandValueChange,
      onRun,
      selectedCommand
    ]
  )

  return {
    onKeyDown
  }
}
