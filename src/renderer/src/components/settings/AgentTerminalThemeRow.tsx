import type { ReactNode } from 'react'
import type React from 'react'
import type { ITheme } from '@xterm/xterm'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/types'

type AgentTerminalThemeRowProps = {
  agent: TuiAgent
  disabled: boolean
  expanded: boolean
  selectionLabel: string
  previewTheme: ITheme | null
  onToggle: () => void
  children?: ReactNode
}

function ThemeSwatch({ theme }: { theme: ITheme | null }): ReactNode {
  if (!theme) {
    return null
  }
  const colors = [theme.background, theme.foreground, theme.blue, theme.green]
  return (
    <span className="flex shrink-0 overflow-hidden rounded-sm border border-border/60">
      {colors.map((color, index) => (
        <span
          key={index}
          className="h-3 w-2"
          style={{ backgroundColor: color ?? 'transparent' }}
        />
      ))}
    </span>
  )
}

export function AgentTerminalThemeRow({
  agent,
  disabled,
  expanded,
  selectionLabel,
  previewTheme,
  onToggle,
  children
}: AgentTerminalThemeRowProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
          expanded && 'bg-accent/50'
        )}
      >
        <AgentIcon agent={agent} size={14} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{getAgentLabel(agent)}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {selectionLabel}
            {disabled
              ? ` · ${translate('auto.components.settings.AgentTerminalThemes.disabled', 'Disabled')}`
              : ''}
          </span>
        </span>
        <ThemeSwatch theme={previewTheme} />
      </button>
      {expanded ? children : null}
    </div>
  )
}
