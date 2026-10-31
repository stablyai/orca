import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { formatKeybinding, formatKeybindingList } from '../../../../shared/keybindings'
import type { TerminalCopyModeConfig } from '../../../../shared/terminal-copy-mode-config'

export function TerminalCopyModeStatus({
  config,
  platform,
  selecting
}: {
  config: TerminalCopyModeConfig
  platform: NodeJS.Platform
  selecting: boolean
}): React.JSX.Element {
  const moves = ['left', 'down', 'up', 'right'] as const
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-background px-2 py-1 text-xs text-foreground">
      <span role="status" className="text-2xs font-semibold uppercase tracking-wide">
        {selecting
          ? translate('terminal.copyMode.selecting', 'Copy mode · Selecting')
          : translate('terminal.copyMode.active', 'Copy mode')}
      </span>
      <span className="inline-flex items-center gap-1">
        {translate('terminal.copyMode.move', 'Move')}
        {moves.map(
          (action) =>
            config.bindings[action][0] && (
              <ShortcutKeyCombo
                key={action}
                keys={formatKeybinding(config.bindings[action][0], platform)}
              />
            )
        )}
      </span>
      {config.bindings.toggleSelection[0] && (
        <span className="inline-flex items-center gap-1">
          {translate('terminal.copyMode.select', 'Select')}
          <ShortcutKeyCombo keys={formatKeybinding(config.bindings.toggleSelection[0], platform)} />
        </span>
      )}
      {config.bindings.copy[0] && (
        <span className="inline-flex items-center gap-1">
          {translate('terminal.copyMode.copy', 'Copy')}
          <ShortcutKeyCombo keys={formatKeybinding(config.bindings.copy[0], platform)} />
        </span>
      )}
      <span className="text-muted-foreground">
        {translate('terminal.copyMode.exit', 'Exit: {{keys}}', {
          keys: formatKeybindingList(config.bindings.exit, platform)
        })}
      </span>
    </div>
  )
}
