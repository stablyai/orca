import { CommandEmpty, CommandSeparator } from '@/components/ui/command'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { TabBarQuickCommandItem } from './TabBarQuickCommandItem'

type TabBarQuickCommandsMenuSectionsProps = {
  filteredRepoCommands: readonly TerminalQuickCommand[]
  filteredProjectCommands: readonly TerminalQuickCommand[]
  filteredGlobalCommands: readonly TerminalQuickCommand[]
  query: string
  onRunCommand: (command: TerminalQuickCommand) => void
  onEditCommand: (command: TerminalQuickCommand) => void
  onDeleteCommand: (command: TerminalQuickCommand) => void
  onCopyProjectCommand: (command: TerminalQuickCommand) => void
}

/** Section list inside the quick-commands menu: personal repo commands, the
 *  read-only orca.yaml project section, then global commands. */
export function TabBarQuickCommandsMenuSections({
  filteredRepoCommands,
  filteredProjectCommands,
  filteredGlobalCommands,
  query,
  onRunCommand,
  onEditCommand,
  onDeleteCommand,
  onCopyProjectCommand
}: TabBarQuickCommandsMenuSectionsProps): React.JSX.Element {
  const totalFiltered =
    filteredRepoCommands.length + filteredProjectCommands.length + filteredGlobalCommands.length
  return (
    <>
      {totalFiltered === 0 ? (
        <CommandEmpty className="py-4 text-center text-[11px]">
          {query.trim()
            ? translate(
                'auto.components.tab.bar.TabBarQuickCommandsButton.b4e7f9a2c1',
                'No commands match'
              )
            : translate(
                'auto.components.tab.bar.TabBarQuickCommandsButton.20bbd75896',
                'No commands'
              )}
        </CommandEmpty>
      ) : null}
      {filteredRepoCommands.map((command) => (
        <TabBarQuickCommandItem
          key={command.id}
          command={command}
          onRun={() => onRunCommand(command)}
          onEdit={() => onEditCommand(command)}
          onDelete={() => onDeleteCommand(command)}
        />
      ))}
      {filteredRepoCommands.length > 0 && filteredProjectCommands.length > 0 ? (
        <CommandSeparator className="my-1" />
      ) : null}
      {filteredProjectCommands.length > 0 ? (
        <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {translate(
            'auto.components.tab.bar.TabBarQuickCommandsButton.d5f1c0a9b3',
            'Project — orca.yaml'
          )}
        </div>
      ) : null}
      {filteredProjectCommands.map((command) => (
        <TabBarQuickCommandItem
          key={command.id}
          command={command}
          onRun={() => onRunCommand(command)}
          onEdit={() => {}}
          onDelete={() => {}}
          onCopyToPersonal={() => onCopyProjectCommand(command)}
        />
      ))}
      {filteredRepoCommands.length + filteredProjectCommands.length > 0 &&
      filteredGlobalCommands.length > 0 ? (
        <CommandSeparator className="my-1" />
      ) : null}
      {filteredGlobalCommands.map((command) => (
        <TabBarQuickCommandItem
          key={command.id}
          command={command}
          onRun={() => onRunCommand(command)}
          onEdit={() => onEditCommand(command)}
          onDelete={() => onDeleteCommand(command)}
        />
      ))}
    </>
  )
}
