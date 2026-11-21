import { useMemo } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/class-names'
import { useStructuredAgentSessionRead } from '../native-chat/session/structured/read/use-structured-agent-session-read'
import { projectStructuredAgentSessionMessages } from '../native-chat/conversation/projection/structured-agent-session-message-projection'
import { nativeChatToolRowVerb } from '../native-chat/tools/lines/native-chat-tool-line-label'
import { NativeChatToolIcon } from '../native-chat/tools/lines/NativeChatToolIcon'
import { nativeChatToolLineLabel } from '../../../../shared/native-chat/tools/native-chat-tool-line-label'
import {
  LOOK_STEPS_SHOWN,
  lookSteps,
  withPlainOrcaCli,
  type LookStep
} from '../../../../shared/bots/bot-look-steps'
import { GitHubIcon } from '../icons/GitHubIcon'
import { LinearIcon } from '../icons/LinearIcon'
import { SlackIcon } from '../icons/SlackIcon'

const SOURCE_ICONS = { slack: SlackIcon, linear: LinearIcon, github: GitHubIcon } as const

function placeText(step: Extract<LookStep, { target: string }>): string {
  if (step.target) {
    return step.target
  }
  return step.thread
    ? translate('bots.lookSteps.slackThread', 'a Slack thread')
    : translate('bots.lookSteps.slackChannel', 'a Slack channel')
}

function stepText(step: LookStep): string {
  const running = step.state === 'running'
  switch (step.kind) {
    case 'read': {
      const place = placeText(step)
      return running
        ? translate('bots.lookSteps.reading', 'Reading {{place}}', { place })
        : translate('bots.lookSteps.read', 'Read {{place}}', { place })
    }
    case 'check': {
      const place = placeText(step)
      return running
        ? translate('bots.lookSteps.checking', 'Checking {{place}}', { place })
        : translate('bots.lookSteps.checked', 'Checked {{place}}', { place })
    }
    case 'find':
      return running
        ? translate('bots.lookSteps.lookingUp', 'Looking up {{query}}', { query: step.target })
        : translate('bots.lookSteps.lookedUp', 'Looked up {{query}}', { query: step.target })
    case 'connections':
      return running
        ? translate('bots.lookSteps.checkingConnections', 'Checking connections')
        : translate('bots.lookSteps.checkedConnections', 'Checked connections')
    case 'tool': {
      // The words the chat's own row shows for this call.
      const label = nativeChatToolLineLabel(step.call, step.result)
      const target = withPlainOrcaCli(label.target)
      return label.verb ? `${nativeChatToolRowVerb(label.verb)} ${target}` : target
    }
  }
}

function StepIcon({ step }: { step: LookStep }): React.JSX.Element {
  const Brand = step.source ? SOURCE_ICONS[step.source] : null
  if (Brand) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Brand className="size-3" />
      </span>
    )
  }
  return step.kind === 'tool' ? (
    <NativeChatToolIcon
      rowWord={step.call.name}
      mcpIdentity={step.call.mcpIdentity}
      input={step.call.input}
    />
  ) : (
    <span className="size-4 shrink-0" />
  )
}

/** The running look's latest steps, read from its own session as its chat would show them. */
export function BotLookSteps({
  bot,
  sessionId
}: {
  bot: BotOnHost
  sessionId: string
}): React.JSX.Element | null {
  // Not viewed: reading the look's steps leaves its session unread like any other.
  const { state } = useStructuredAgentSessionRead({
    sessionId,
    target: botTarget(bot),
    isViewed: false
  })
  const steps = useMemo(
    () =>
      lookSteps(projectStructuredAgentSessionMessages(state.items, [], state.submissions)).slice(
        -LOOK_STEPS_SHOWN
      ),
    [state.items, state.submissions]
  )
  if (steps.length === 0) {
    return null
  }
  return (
    <div className="mx-2 mb-1.5 flex flex-col gap-1 border-l border-border py-0.5 pl-2.5">
      {steps.map((step) => (
        <div
          key={step.position}
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-2xs',
            step.state === 'running' ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          <StepIcon step={step} />
          <span className="min-w-0 flex-1 truncate">{stepText(step)}</span>
          {step.state === 'running' ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin" />
          ) : step.state === 'failed' ? (
            <X className="size-3 shrink-0" />
          ) : (
            <Check className="size-3 shrink-0" />
          )}
        </div>
      ))}
    </div>
  )
}
