import { Fragment, useCallback, useState, type RefObject } from 'react'
import { CommandList, CommandSeparator } from '@/components/ui/command'
import { VirtualizedList } from '@/components/virtualized-list'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'
import { translate } from '@/i18n/i18n'

export function TabBarQuickCommandsList({
  commands,
  firstGlobalCommand,
  selectedKey,
  query,
  commandListRef,
  renderCommand
}: {
  commands: readonly HostedTerminalQuickCommand[]
  firstGlobalCommand: HostedTerminalQuickCommand | undefined
  selectedKey: string
  query: string
  commandListRef: RefObject<HTMLDivElement | null>
  renderCommand: (entry: HostedTerminalQuickCommand) => React.JSX.Element
}): React.JSX.Element {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const attachList = useCallback(
    (element: HTMLDivElement | null): void => {
      commandListRef.current = element
      setScrollElement(element)
    },
    [commandListRef]
  )

  return (
    <CommandList ref={attachList} className="max-h-72">
      <div className="py-1">
        {commands.length === 0 ? (
          <div className="py-4 text-center text-2xs">
            {query.trim()
              ? translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.b4e7f9a2c1',
                  'No commands match'
                )
              : translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.20bbd75896',
                  'No commands'
                )}
          </div>
        ) : null}
        <VirtualizedList
          rows={commands}
          getRowKey={(entry) => entry.key}
          scrollElement={scrollElement}
          estimateRowHeightPx={56}
          activeRowKey={selectedKey}
          minimumRows={10}
          renderRow={(entry) => (
            <Fragment key={entry.key}>
              {entry === firstGlobalCommand ? <CommandSeparator className="my-1" /> : null}
              {renderCommand(entry)}
            </Fragment>
          )}
        />
      </div>
    </CommandList>
  )
}
