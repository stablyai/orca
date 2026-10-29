import { useState } from 'react'
import { Minus, SquareTerminal, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  minimizePlainSshPanel,
  removePlainSshPanel,
  showPlainSshPanel,
  usePlainSshPanels,
  type PlainSshPanel
} from '@/ssh/plain-ssh-terminal-panels'
import { PlainSshTerminalView, type PlainSshTerminalPhase } from './PlainSshTerminalView'

export function plainSshUnmanagedNotice(): string {
  return translate(
    'auto.components.plainSshTerminal.unmanaged',
    'Plain SSH — unmanaged. Not an Orca workspace: agents and tabs here aren’t tracked, and this terminal isn’t restored. Closing it ends the SSH session.'
  )
}

function phaseText(phase: PlainSshTerminalPhase): string | null {
  switch (phase.kind) {
    case 'opening':
    case 'open':
      return null
    case 'failed':
      return phase.message
    case 'ended':
      return phase.signal
        ? translate(
            'auto.components.plainSshTerminal.endedBySignal',
            'ssh was stopped (signal {{signal}}). Close this window when you’re done reading.',
            { signal: phase.signal }
          )
        : translate(
            'auto.components.plainSshTerminal.ended',
            'ssh exited with code {{code}}. Close this window when you’re done reading.',
            { code: phase.exitCode }
          )
  }
}

function HeaderIconButton({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** A non-modal window over Orca; minimized windows wait in a strip at the bottom right. */
function PlainSshTerminalCard({ panel }: { panel: PlainSshPanel }): React.JSX.Element {
  const [phase, setPhase] = useState<PlainSshTerminalPhase>({ kind: 'opening' })
  const message = phaseText(phase)
  return (
    <section
      aria-label={translate('auto.components.plainSshTerminal.title', 'Plain SSH · {{host}}', {
        host: panel.label
      })}
      data-plain-ssh-terminal={panel.targetId}
      // Keep minimized panels mounted to preserve their SSH session and scrollback.
      className={cn(
        'pointer-events-auto flex h-[26rem] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-floating',
        // A failed open has only its error to show.
        phase.kind === 'failed' && 'h-auto',
        panel.minimized && 'hidden'
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">
          {translate('auto.components.plainSshTerminal.title', 'Plain SSH · {{host}}', {
            host: panel.label
          })}
        </div>
        <HeaderIconButton
          label={translate('auto.components.plainSshTerminal.minimize', 'Minimize')}
          onClick={() => minimizePlainSshPanel(panel.targetId)}
        >
          <Minus />
        </HeaderIconButton>
        <HeaderIconButton
          label={translate('auto.components.plainSshTerminal.close', 'Close and end session')}
          onClick={() => removePlainSshPanel(panel.targetId)}
        >
          <X />
        </HeaderIconButton>
      </header>
      <p className="border-b border-border bg-muted px-3 py-1.5 text-xs text-status-warning">
        {plainSshUnmanagedNotice()}
      </p>
      {message ? (
        <p className="px-3 py-1.5 text-xs text-destructive [overflow-wrap:anywhere]">{message}</p>
      ) : null}
      {/* An empty terminal under a failed open's error would read as a live session. */}
      <div
        data-plain-ssh-screen
        className={cn('min-h-0 flex-1', phase.kind === 'failed' && 'hidden')}
      >
        <PlainSshTerminalView
          targetId={panel.targetId}
          hidden={panel.minimized}
          onPhase={setPhase}
        />
      </div>
    </section>
  )
}

export function PlainSshTerminalPanels(): React.JSX.Element | null {
  const panels = usePlainSshPanels()
  if (panels.length === 0) {
    return null
  }
  const minimized = panels.filter((panel) => panel.minimized)
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
      {panels.map((panel) => (
        <PlainSshTerminalCard key={panel.targetId} panel={panel} />
      ))}
      {minimized.length > 0 ? (
        <div className="pointer-events-auto flex flex-wrap justify-end gap-2">
          {minimized.map((panel) => (
            <Button
              key={panel.targetId}
              type="button"
              size="xs"
              variant="outline"
              onClick={() => showPlainSshPanel(panel.targetId, panel.label)}
            >
              <SquareTerminal />
              {translate('auto.components.plainSshTerminal.title', 'Plain SSH · {{host}}', {
                host: panel.label
              })}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
