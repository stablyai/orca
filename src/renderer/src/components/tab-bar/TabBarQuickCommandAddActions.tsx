import { Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { TerminalQuickCommandHost } from '@/hooks/use-terminal-quick-command-hosts'

export function TabBarQuickCommandAddActions({
  hosts,
  onAdd
}: {
  hosts: readonly TerminalQuickCommandHost[]
  onAdd: (hostId: TerminalQuickCommandHost['hostId']) => void
}): React.JSX.Element {
  return (
    <div className="border-t border-border/50 p-1">
      {hosts.map((host) => (
        <button
          key={host.hostId}
          type="button"
          onClick={() => onAdd(host.hostId)}
          className="flex w-full cursor-pointer items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Plus className="size-3.5" />
          {hosts.length === 1
            ? translate(
                'auto.components.tab.bar.TabBarQuickCommandAddActions.45a2f36d51',
                'Command'
              )
            : translate(
                'auto.components.tab.bar.TabBarQuickCommandAddActions.b856c833ae',
                'Command on {{value0}}',
                { value0: host.label }
              )}
        </button>
      ))}
    </div>
  )
}
