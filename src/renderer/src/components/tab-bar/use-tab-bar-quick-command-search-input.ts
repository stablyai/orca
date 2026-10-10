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
      onCommandValueChange,
      onRun,
      selectedCommand
    ]
  )

  return {
    onKeyDown
  }
}
