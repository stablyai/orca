import {
  ArrowLeftRight,
  Check,
  MessagesSquare,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import { Trans } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { i18n, translate } from '@/i18n/i18n'
import type { AgentSurface } from './use-onboarding-flow-types'

type AgentSurfaceStepProps = {
  agentSurface: AgentSurface
  onSelect: (surface: AgentSurface) => void
  /** Detection finished and no installed agent can open as a chat. */
  noChatAgentDetected?: boolean
}

export function AgentSurfaceStep({
  agentSurface,
  onSelect,
  noChatAgentDetected = false
}: AgentSurfaceStepProps) {
  return (
    <div className="space-y-5">
      <div role="radiogroup" className="grid gap-3 md:grid-cols-2">
        <SurfaceOption
          icon={MessagesSquare}
          label={translate('components.onboarding.agentSurface.chat.label', 'Chat UI')}
          badge={translate('components.onboarding.agentSurface.chat.badge', 'Experimental')}
          description={translate(
            'components.onboarding.agentSurface.chat.opensInChat',
            'Agents open in a chat with rendered messages and diffs. Agents without chat support, and SSH or WSL projects, open in a terminal.'
          )}
          warning={
            noChatAgentDetected
              ? translate(
                  'components.onboarding.agentSurface.chat.noneDetected',
                  'None of your detected agents work in Chat UI.'
                )
              : undefined
          }
          preview={<ChatPreview />}
          selected={agentSurface === 'chat'}
          onClick={() => onSelect('chat')}
        />
        <SurfaceOption
          icon={SquareTerminal}
          label={translate('components.onboarding.agentSurface.terminal.label', 'Terminal')}
          description={translate(
            'components.onboarding.agentSurface.terminal.description',
            "Each agent's own CLI in a terminal, exactly as it ships. Works with every CLI agent."
          )}
          preview={<TerminalPreview />}
          selected={agentSurface === 'terminal'}
          onClick={() => onSelect('terminal')}
        />
      </div>
      <div className="flex items-start gap-3 rounded-lg border border-border px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground">
          <ArrowLeftRight className="size-4" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium text-foreground">
            {translate(
              'components.onboarding.agentSurface.switchAnyTime',
              'Not a permanent choice. Switch any time.'
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <Trans
              i18n={i18n}
              defaults={translate(
                'components.onboarding.agentSurface.switchHow',
                'Flip between Chat UI and Terminal in <em>Settings → Experimental</em>. Whichever you pick, any agent can still open in a terminal from the <em>+</em> menu.'
              )}
              components={{ em: <span className="font-medium text-foreground" /> }}
            />
          </p>
        </div>
      </div>
    </div>
  )
}

function SurfaceOption({
  icon: Icon,
  label,
  badge,
  description,
  warning,
  preview,
  selected,
  onClick
}: {
  icon: LucideIcon
  label: string
  badge?: string
  description: string
  warning?: string
  preview: React.ReactNode
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cn(
        'overflow-hidden rounded-xl border p-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-foreground/60 bg-accent' : 'border-border hover:bg-accent/60'
      )}
      onClick={onClick}
    >
      <div
        aria-hidden
        className="relative mb-3 h-32 overflow-hidden rounded-lg border border-border"
      >
        {preview}
        {selected && (
          <div className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background shadow-sm">
            <Check className="size-3" strokeWidth={3} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon className="size-4 text-muted-foreground" />
        {label}
        {badge ? <Badge variant="outline">{badge}</Badge> : null}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      {warning ? <p className="mt-1.5 text-xs text-status-warning-text">{warning}</p> : null}
    </button>
  )
}

function ChatPreview() {
  return (
    <div className="flex size-full flex-col gap-2 bg-chat-canvas p-3">
      <div className="ml-auto h-4 w-2/5 rounded-md border border-chat-user-border bg-chat-user-surface" />
      <div className="space-y-1.5">
        <div className="h-1.5 w-11/12 rounded-sm bg-foreground/15" />
        <div className="h-1.5 w-3/4 rounded-sm bg-foreground/15" />
      </div>
      <div className="space-y-1 rounded-md border border-chat-code-border bg-chat-code-surface p-1.5">
        <div className="h-1 w-2/3 rounded-sm bg-chat-diff-removed" />
        <div className="h-1 w-4/5 rounded-sm bg-chat-diff-added" />
      </div>
      <div className="mt-auto flex h-5 items-center gap-1.5 rounded-md border border-chat-composer-border bg-chat-composer-surface px-2">
        <span className="h-1 flex-1 rounded-sm bg-foreground/10" />
        <span className="size-2 rounded-full bg-foreground/40" />
      </div>
    </div>
  )
}

function TerminalPreview() {
  return (
    <div className="flex size-full flex-col gap-1.5 bg-editor-surface p-3">
      <div className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-status-success" />
        <span className="h-1.5 w-1/4 rounded-sm bg-foreground/30" />
      </div>
      <div className="h-1.5 w-5/6 rounded-sm bg-foreground/15" />
      <div className="h-1.5 w-2/3 rounded-sm bg-foreground/15" />
      <div className="h-1.5 w-3/4 rounded-sm bg-foreground/15" />
      <div className="h-1.5 w-1/2 rounded-sm bg-foreground/15" />
      <div className="mt-auto flex items-center gap-1.5">
        <span className="h-1.5 w-2 rounded-sm bg-foreground/40" />
        <span className="h-2.5 w-1 bg-foreground/60" />
      </div>
    </div>
  )
}
