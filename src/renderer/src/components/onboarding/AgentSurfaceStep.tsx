import {
  ArrowLeftRight,
  ArrowUp,
  Check,
  ChevronRight,
  FileCode2,
  MessagesSquare,
  Sparkles,
  SquareTerminal,
  type LucideIcon
} from 'lucide-react'
import { Trans } from 'react-i18next'
import { cn } from '@/lib/utils'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
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
    <div className="space-y-6">
      <RadioGroup
        value={agentSurface}
        onValueChange={(value) => {
          if (value === 'chat' || value === 'terminal') {
            onSelect(value)
          }
        }}
        layout="cards"
      >
        <SurfaceOption
          value="chat"
          icon={MessagesSquare}
          label={translate('components.onboarding.agentSurface.chat.label', 'Chat UI')}
          description={translate(
            'components.onboarding.agentSurface.chat.description',
            'Agents reply in a chat, with rendered messages and diffs.'
          )}
          note={translate(
            'components.onboarding.agentSurface.chat.terminalFallback',
            'Agents without chat support, and SSH or WSL projects, still open in a terminal.'
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
        />
        <SurfaceOption
          value="terminal"
          icon={SquareTerminal}
          label={translate('components.onboarding.agentSurface.terminal.label', 'Terminal')}
          description={translate(
            'components.onboarding.agentSurface.terminal.description',
            "Each agent's own CLI, exactly as it ships. Works with every CLI agent."
          )}
          preview={<TerminalPreview />}
          selected={agentSurface === 'terminal'}
        />
      </RadioGroup>
      <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <ArrowLeftRight className="size-3.5 shrink-0" />
        <span>
          <Trans
            i18n={i18n}
            defaults={translate(
              'components.onboarding.agentSurface.switchNote',
              'Not a permanent choice. Switch any time in <em>Settings → Chat UI</em>.'
            )}
            components={{
              em: <span className="font-medium text-foreground" />
            }}
          />
        </span>
      </p>
    </div>
  )
}

function SurfaceOption({
  value,
  icon: Icon,
  label,
  description,
  note,
  warning,
  preview,
  selected
}: {
  value: AgentSurface
  icon: LucideIcon
  label: string
  description: string
  note?: string
  warning?: string
  preview: React.ReactNode
  selected: boolean
}) {
  return (
    <RadioGroupItem value={value} variant="media">
      <div
        aria-hidden
        className="h-52 border-b border-border bg-muted/40 p-5 transition-colors group-data-[state=checked]:bg-muted/70"
      >
        <div className="size-full overflow-hidden rounded-lg border border-border shadow-lg">
          {preview}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-5 pt-4 pb-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="size-4 text-muted-foreground" />
          {label}
          <span
            className={cn(
              'ml-auto grid size-4 shrink-0 place-items-center rounded-full border transition-colors',
              selected ? 'border-foreground bg-foreground text-background' : 'border-input'
            )}
          >
            {selected ? <Check className="size-2.5" strokeWidth={3.5} /> : null}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        {note ? <p className="text-xs leading-relaxed text-muted-foreground/70">{note}</p> : null}
        {warning ? <p className="text-xs text-status-warning-text">{warning}</p> : null}
      </div>
    </RadioGroupItem>
  )
}

// Code and CLI output, not prose: they stay untranslated, like the source and tools they mimic.
const PREVIEW_FILE = 'api.ts'
const TERMINAL_TITLE = 'zsh — claude'
const TERMINAL_LINES: {
  id: string
  tone: 'prompt' | 'input' | 'step' | 'detail' | 'removed' | 'added'
  text: string
}[] = [
  { id: 'launch', tone: 'prompt', text: 'claude' },
  { id: 'request', tone: 'input', text: '> add retry to fetchUser' },
  { id: 'update', tone: 'step', text: 'Update(src/api.ts)' },
  { id: 'diff-summary', tone: 'detail', text: '⎿ 1 addition, 1 removal' },
  { id: 'removed-line', tone: 'removed', text: '12 - return fetch(url)' },
  { id: 'added-line', tone: 'added', text: '12 + return withRetry(fetch, url)' },
  { id: 'complete', tone: 'step', text: 'Done. Retries capped at 3.' }
]

// The previews contrast on purpose: chat is proportional type, bubbles and cards with no raw
// code, while the terminal is nothing but monospace output.
function ChatPreview() {
  return (
    <div className="flex size-full flex-col gap-3 bg-chat-canvas p-3.5 text-xs leading-snug">
      <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-foreground px-3 py-1.5 text-background">
        {translate(
          'components.onboarding.agentSurface.preview.userMessage',
          'Add retry to fetchUser'
        )}
      </div>
      <div className="flex items-start gap-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-foreground">
          <Sparkles className="size-3" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="pt-0.5 text-foreground">
            {translate(
              'components.onboarding.agentSurface.preview.agentMessage',
              'Failed requests now retry up to 3 times.'
            )}
          </div>
          <div className="flex w-fit items-center gap-1.5 rounded-full border border-chat-code-border bg-chat-code-surface py-1 pr-2 pl-2.5">
            <FileCode2 className="size-3 text-muted-foreground" />
            <span className="font-medium text-foreground">{PREVIEW_FILE}</span>
            <span className="text-status-success">+1</span>
            <span className="text-destructive">−1</span>
            <ChevronRight className="size-3 text-muted-foreground" />
          </div>
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 rounded-xl border border-chat-composer-border bg-chat-composer-surface py-1.5 pr-1.5 pl-3">
        <span className="truncate text-muted-foreground">
          {translate(
            'components.onboarding.agentSurface.preview.composerPlaceholder',
            'Ask a follow-up…'
          )}
        </span>
        <span className="ml-auto grid size-5 place-items-center rounded-full bg-foreground text-background">
          <ArrowUp className="size-3" strokeWidth={2.5} />
        </span>
      </div>
    </div>
  )
}

const TERMINAL_TONE_CLASS: Record<(typeof TERMINAL_LINES)[number]['tone'], string> = {
  prompt: '',
  input: 'text-foreground',
  step: '',
  detail: 'pl-3 text-muted-foreground',
  removed: 'pl-5 text-destructive',
  added: 'pl-5 text-status-success'
}

function TerminalPreview() {
  // Forced dark: a terminal reads as a terminal in either app theme.
  return (
    <div className="dark flex size-full flex-col bg-background font-mono text-[10px] leading-[1.6] text-foreground/75">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <span className="size-1.5 rounded-full bg-foreground/25" />
        <span className="size-1.5 rounded-full bg-foreground/25" />
        <span className="size-1.5 rounded-full bg-foreground/25" />
        <span className="mx-auto pr-6 text-muted-foreground">{TERMINAL_TITLE}</span>
      </div>
      <div className="px-3 pt-1.5">
        {TERMINAL_LINES.map((line) => (
          <div key={line.id} className={cn('truncate', TERMINAL_TONE_CLASS[line.tone])}>
            {line.tone === 'prompt' ? <span className="text-status-success">❯ </span> : null}
            {line.tone === 'step' ? <span className="text-status-success">● </span> : null}
            {line.text}
          </div>
        ))}
        <span className="mt-0.5 inline-block h-2.5 w-1.5 bg-foreground/80" />
      </div>
    </div>
  )
}
