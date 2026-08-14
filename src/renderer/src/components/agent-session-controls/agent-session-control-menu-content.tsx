import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { formatTokens } from '@/components/stats/usage-formatters'
import { translate } from '@/i18n/i18n'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionLabel
} from '../native-chat/native-chat-session-option-labels'
import { CustomModelInput } from './agent-session-controls-support'

export function ContextDonut({ percent }: { percent: number | null }): React.JSX.Element {
  const value = Math.max(0, Math.min(100, percent ?? 0))
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0 -rotate-90" aria-hidden="true">
      <circle
        cx="10"
        cy="10"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="text-muted-foreground/30"
      />
      <circle
        cx="10"
        cy="10"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        pathLength="100"
        strokeDasharray="100"
        strokeDashoffset={100 - value}
        className="text-foreground"
      />
    </svg>
  )
}

export function contextSummary(context: AgentSessionContextSnapshot): string {
  if (context.usedTokens === null) {
    return translate('components.native-chat.context.unavailable', 'Context unavailable')
  }
  const used = `${context.estimated ? '~' : ''}${formatTokens(context.usedTokens)}`
  if (context.maxTokens === null) {
    return translate('components.native-chat.context.used', '{{value0}} tokens used', {
      value0: used
    })
  }
  const remaining = context.remainingTokens ?? Math.max(0, context.maxTokens - context.usedTokens)
  return translate(
    'components.native-chat.context.summary',
    '{{value0}}% used · {{value1}} / {{value2}} tokens · {{value3}} free',
    {
      value0: Math.round(context.usedPercent ?? (context.usedTokens / context.maxTokens) * 100),
      value1: used,
      value2: formatTokens(context.maxTokens),
      value3: formatTokens(remaining)
    }
  )
}

export function compactionLabel(context: AgentSessionContextSnapshot): string | null {
  if (context.compaction === 'idle') {
    return null
  }
  if (context.compaction === 'requested') {
    return 'Compaction queued'
  }
  if (context.compaction === 'running') {
    return 'Compacting context'
  }
  if (context.compaction === 'completed') {
    return 'Context compacted'
  }
  return 'Compaction failed'
}

function ChoiceBody(props: { label: string; description?: string }): React.JSX.Element {
  return (
    <div className="min-w-0 py-0.5">
      <div>{props.label}</div>
      {props.description ? (
        <div className="text-xs font-normal text-muted-foreground">{props.description}</div>
      ) : null}
    </div>
  )
}

export function DescriptorMenuRows(props: {
  descriptor: SessionOptionDescriptor
  pending: boolean
  setValue: (value: SessionOptionValue) => void
  invokeAction: () => void
  setCustomModel?: (modelId: string) => Promise<boolean>
}): React.JSX.Element {
  const { descriptor, pending, setValue, invokeAction, setCustomModel } = props
  if (descriptor.action?.type === 'toggle-command') {
    return (
      <DropdownMenuItem disabled={!descriptor.settable || pending} onSelect={invokeAction}>
        {translate('components.native-chat.composer.toggleOption', 'Toggle {{value0}}', {
          value0: nativeChatSessionOptionLabel(descriptor).toLowerCase()
        })}
      </DropdownMenuItem>
    )
  }
  if (descriptor.action?.type === 'agent-picker') {
    return (
      <DropdownMenuItem disabled={!descriptor.settable || pending} onSelect={invokeAction}>
        {translate(
          'components.native-chat.composer.chooseInAgentPicker',
          'Choose in agent picker…'
        )}
      </DropdownMenuItem>
    )
  }
  if (descriptor.kind.type === 'boolean') {
    const selected =
      descriptor.kind.currentValue === true
        ? 'on'
        : descriptor.kind.currentValue === false
          ? 'off'
          : undefined
    return (
      <>
        {selected === undefined ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {translate(
              'components.native-chat.composer.valueUnknown',
              'Current value unknown — pick On or Off'
            )}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuRadioGroup value={selected} onValueChange={(next) => setValue(next === 'on')}>
          <DropdownMenuRadioItem value="on" disabled={!descriptor.settable || pending}>
            {translate('components.native-chat.composer.optionValue.on', 'On')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off" disabled={!descriptor.settable || pending}>
            {translate('components.native-chat.composer.optionValue.off', 'Off')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </>
    )
  }
  return (
    <>
      <DropdownMenuRadioGroup
        value={descriptor.kind.currentValue}
        onValueChange={(value) => setValue(value)}
      >
        {descriptor.kind.choices.map((choice) => (
          <DropdownMenuRadioItem
            key={choice.value}
            value={choice.value}
            disabled={!descriptor.settable || pending}
          >
            <ChoiceBody
              label={nativeChatSessionChoiceLabel(choice)}
              description={choice.description}
            />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {descriptor.category === 'model' && setCustomModel ? (
        <>
          <DropdownMenuSeparator />
          <CustomModelInput pending={pending} onSubmit={setCustomModel} />
        </>
      ) : null}
    </>
  )
}

export function currentOptionLabel(descriptor: SessionOptionDescriptor): string {
  if (descriptor.kind.type === 'boolean') {
    if (descriptor.kind.currentValue === true) {
      return 'On'
    }
    if (descriptor.kind.currentValue === false) {
      return 'Off'
    }
    return 'Unknown'
  }
  const value = descriptor.kind.currentValue
  return (
    descriptor.kind.choices.find((choice) => choice.value === value)?.label ?? value ?? 'Unknown'
  )
}
