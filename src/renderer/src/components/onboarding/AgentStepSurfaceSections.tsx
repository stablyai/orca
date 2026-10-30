import { Info, MessagesSquare, SquareTerminal } from 'lucide-react'
import { Trans } from 'react-i18next'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { i18n, translate } from '@/i18n/i18n'
import type { AgentSurface } from './use-onboarding-flow-types'
import { TerminalLaunchDemo } from './TerminalLaunchDemo'

const emphasis = { em: <span className="font-medium text-foreground" /> }

/** Terminal mode marks which agents could also open in Chat UI. */
export function chatAvailableDetail(opensAsChat: boolean): React.ReactNode {
  return opensAsChat ? (
    <>
      <MessagesSquare />
      {translate('components.onboarding.agentStep.chatAvailable', 'Chat available')}
    </>
  ) : undefined
}

const surfacePillClass =
  'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 font-medium text-foreground'

function AgentSurfaceLabel({ surface }: { surface: AgentSurface }) {
  return surface === 'chat' ? (
    <>
      <MessagesSquare className="size-3.5" />
      {translate('components.onboarding.agentSurface.chat.label', 'Chat UI')}
    </>
  ) : (
    <>
      <SquareTerminal className="size-3.5" />
      {translate('components.onboarding.agentStep.terminalUi', 'Terminal UI')}
    </>
  )
}

/** Read-only in onboarding, where the previous page chose; with onChange, both options are pickable. */
export function AgentSurfaceModeRow({
  surface,
  onChange
}: {
  surface: AgentSurface
  onChange?: (surface: AgentSurface) => void
}) {
  const label = translate('components.onboarding.agentStep.agentsOpenIn', 'Agents open in')
  if (!onChange) {
    return (
      <div className="flex shrink-0 items-center gap-2.5 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className={cn(surfacePillClass, 'border-foreground/60 bg-accent')}>
          <AgentSurfaceLabel surface={surface} />
        </span>
      </div>
    )
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
      <span aria-hidden>{label}</span>
      <RadioGroup
        aria-label={label}
        layout="inline"
        orientation="horizontal"
        value={surface}
        onValueChange={(value) => {
          if (value === 'chat' || value === 'terminal') {
            onChange(value)
          }
        }}
      >
        {(['chat', 'terminal'] as const).map((option) => (
          <RadioGroupItem key={option} value={option} variant="pill">
            <AgentSurfaceLabel surface={option} />
          </RadioGroupItem>
        ))}
      </RadioGroup>
    </div>
  )
}

export function AgentStepNotice({
  tone = 'neutral',
  children,
  actionLabel,
  onAction
}: {
  tone?: 'neutral' | 'warning'
  children: React.ReactNode
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-xs text-muted-foreground',
        tone === 'warning' ? 'border-status-warning-border' : 'border-border'
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {actionLabel && onAction ? (
        <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

export function NoChatAgentsNotice({
  anyDetected,
  chatAgentLabels,
  onUseTerminal
}: {
  anyDetected: boolean
  chatAgentLabels: readonly string[]
  onUseTerminal: () => void
}) {
  if (!anyDetected) {
    return (
      <AgentStepNotice>
        <Trans
          i18n={i18n}
          defaults={translate(
            'components.onboarding.agentStep.noAgentsForChat',
            '<em>No agents found on your PATH.</em> Chat UI works with {{agents}}. Install one, or continue and add an agent later.',
            {
              agents: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
                chatAgentLabels
              )
            }
          )}
          components={emphasis}
        />
      </AgentStepNotice>
    )
  }
  return (
    <AgentStepNotice tone="warning" actionLabel={terminalInsteadLabel()} onAction={onUseTerminal}>
      <Trans
        i18n={i18n}
        defaults={translate(
          'components.onboarding.agentStep.noChatAgentsDetected',
          '<em>None of your agents work in Chat UI.</em> They would all open in a terminal, so Terminal fits better.'
        )}
        components={emphasis}
      />
    </AgentStepNotice>
  )
}

export function TerminalFitNotice({
  agentLabel,
  onUseTerminal
}: {
  agentLabel: string
  onUseTerminal: () => void
}) {
  return (
    <AgentStepNotice tone="warning" actionLabel={terminalInsteadLabel()} onAction={onUseTerminal}>
      <Trans
        i18n={i18n}
        defaults={translate(
          'components.onboarding.agentStep.opensInTerminalFit',
          '<em>{{agent}} opens in a terminal</em>, so Terminal fits better.',
          { agent: agentLabel }
        )}
        components={emphasis}
      />
    </AgentStepNotice>
  )
}

function terminalInsteadLabel(): string {
  return translate('components.onboarding.agentStep.useTerminalInstead', 'Use Terminal instead')
}

/** Chat UI users can still start any agent's CLI from the + menu; the hover card shows how. */
export function ChatModeTerminalTip() {
  const howLabel = translate(
    'components.onboarding.agentStep.terminalTipHow',
    'Show how to start an agent in a terminal'
  )
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span>
        <Trans
          i18n={i18n}
          defaults={translate(
            'components.onboarding.agentStep.terminalTip',
            'You can also start any agent in a terminal from the <em>+</em> menu.'
          )}
          components={emphasis}
        />
      </span>
      {/* A tooltip, not a hover card, so keyboard focus opens it too. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={howLabel}
            className="grid size-5 place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        {/* Above the onboarding overlay (z-100), like the stepper tooltips. */}
        <TooltipContent
          side="top"
          sideOffset={6}
          variant="tab-preview"
          showArrow={false}
          className="z-[110] w-auto"
        >
          <div className="flex flex-col gap-2.5">
            <TerminalLaunchDemo />
            <p className="max-w-[300px] text-xs leading-relaxed text-muted-foreground">
              <Trans
                i18n={i18n}
                defaults={translate(
                  'components.onboarding.agentStep.terminalTipCaption',
                  "Click <em>+</em> in the tab bar, then pick an agent marked <em>(CLI)</em>. If a chat agent's CLI is installed, hover its row and click the terminal icon to use the CLI."
                )}
                components={emphasis}
              />
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

export function TerminalModeChatTip({ onUseChat }: { onUseChat: () => void }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <MessagesSquare className="size-3.5" />
      <span>
        <Trans
          i18n={i18n}
          defaults={translate(
            'components.onboarding.agentStep.chatTip',
            'Want chat too? Turn it on any time in <em>Settings → Chat UI</em>.'
          )}
          components={emphasis}
        />
      </span>
      <button
        type="button"
        className="font-medium text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onUseChat}
      >
        {translate('components.onboarding.agentStep.turnOnChat', 'Turn on now')}
      </button>
    </div>
  )
}
