import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'

// Shell text, not prose: what a terminal shows when the agent's CLI starts.
const DEMO_PROMPT = '~/uploader ❯'
const DEMO_COMMAND = 'gemini'

// Pixel positions here are the keyframe targets in main.css (.onboarding-launch-demo).
export function TerminalLaunchDemo(): React.JSX.Element {
  const cli = translate('auto.components.tab.bar.QuickLaunchButton.cliTag', '(CLI)')
  return (
    <div
      aria-hidden
      className="onboarding-launch-demo relative h-[172px] w-[300px] overflow-hidden rounded-md border border-border bg-background text-[11px]"
    >
      <div className="absolute inset-x-0 top-0 flex h-7 items-center gap-1 border-b border-border bg-muted px-1.5">
        <span className="inline-flex h-5 w-16 items-center gap-1 rounded border border-border bg-background px-1.5 font-medium">
          <MessagesSquare className="size-3" />
          {getAgentLabel('claude')}
        </span>
        <span
          data-demo="new-tab"
          className="inline-flex h-5 items-center gap-1 overflow-hidden whitespace-nowrap rounded border border-border bg-background font-medium"
        >
          <SquareTerminal className="size-3 shrink-0" />
          {getAgentLabel('gemini')}
        </span>
        <span
          data-demo="plus"
          className="grid size-5 place-items-center rounded text-sm text-muted-foreground"
        >
          +
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-7 flex flex-col gap-1.5 p-2.5">
        <span className="max-w-[75%] self-end rounded-lg bg-foreground px-2 py-1 text-background">
          {translate('components.onboarding.launchDemo.userMessage', 'Fix the flaky upload test')}
        </span>
        <span className="max-w-[80%] rounded-lg border border-border px-2 py-1">
          {translate(
            'components.onboarding.launchDemo.agentMessage',
            "Found it. The retry timer wasn't mocked."
          )}
        </span>
      </div>
      <div
        data-demo="terminal"
        className="absolute inset-x-0 bottom-0 top-7 bg-editor-surface p-2.5 font-mono leading-relaxed text-foreground"
      >
        <div>
          <span className="text-status-success">{DEMO_PROMPT}</span> {DEMO_COMMAND}
        </div>
        <div className="text-muted-foreground">
          {translate('components.onboarding.launchDemo.cliReady', '{{agent}} CLI ready.', {
            agent: getAgentLabel('gemini')
          })}
        </div>
        <div>
          <span className="text-status-success">❯</span>{' '}
          <span className="inline-block h-2.5 w-1.5 bg-foreground align-[-1px]" />
        </div>
      </div>
      <div
        data-demo="menu"
        className="absolute left-[74px] top-[30px] w-44 rounded-md border border-border bg-popover p-1 shadow-md"
      >
        <DemoRow agent="claude" label={getAgentLabel('claude')} alt />
        <DemoRow agent="codex" label={getAgentLabel('codex')} />
        <div className="my-[3px] h-px bg-border" />
        <DemoRow agent="copilot" label={`${getAgentLabel('copilot')} ${cli}`} />
        <DemoRow agent="gemini" label={`${getAgentLabel('gemini')} ${cli}`} picked />
      </div>
      <svg
        data-demo="cursor"
        viewBox="0 0 16 20"
        className="absolute left-0 top-0 h-[17px] w-[13px] fill-background stroke-foreground"
      >
        <path d="M1 1l0 15 4-4 3 7 3-1.3-3-6.7h6z" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

function DemoRow({
  agent,
  label,
  alt,
  picked
}: {
  agent: 'claude' | 'codex' | 'copilot' | 'gemini'
  label: string
  alt?: boolean
  picked?: boolean
}): React.JSX.Element {
  return (
    <div
      data-demo={picked ? 'picked-row' : undefined}
      className="flex h-[22px] items-center gap-1.5 rounded px-1.5"
    >
      <AgentIcon agent={agent} size={11} />
      <span className="truncate">{label}</span>
      {alt ? <SquareTerminal data-demo="alt" className="ml-auto size-3 shrink-0" /> : null}
    </div>
  )
}
