import { defineFixture } from '../../component-fixtures/component-fixture'
import { suggestedRunCommands } from '@/hooks/use-cloud-suggested-run-commands'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'
import { TabBarQuickCommandItem } from './TabBarQuickCommandItem'

const HOST = { hostId: 'runtime:env' as const, label: 'Orca Cloud' }
const noop = (): void => {}

const saved: HostedTerminalQuickCommand = {
  command: {
    id: 'saved-dev',
    label: 'dev server',
    command: 'pnpm dev --port 3000',
    appendEnter: true
  },
  hostId: HOST.hostId,
  hostLabel: HOST.label,
  key: 'runtime:env\0saved-dev'
}

// The Run menu's rows in a cloud workspace: a saved command, then package.json suggestions
// (Copy only, "From package.json"). Suggestions are re-read when the menu opens (LC2-P3).
export const cloudRunMenuRows = defineFixture({
  width: 420,
  render: () => (
    <div role="listbox" className="flex flex-col rounded-lg border border-border bg-popover py-1">
      {[
        saved,
        ...suggestedRunCommands(
          JSON.stringify({
            packageManager: 'pnpm@9.0.0',
            scripts: { test: 'vitest', typecheck: 'tsc', lint: 'eslint .' }
          }),
          HOST
        )
      ].map((entry, index) => (
        <TabBarQuickCommandItem
          key={entry.key}
          entry={entry}
          showHostLabel={false}
          selected={index === 1}
          onRun={noop}
          onEdit={noop}
          onDelete={noop}
        />
      ))}
    </div>
  )
})
