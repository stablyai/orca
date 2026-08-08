import { memo, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTokens } from '@/components/stats/usage-formatters'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from '../native-chat/native-chat-session-option-labels'
import type { NativeChatOptionPickerRequest } from '../native-chat/native-chat-composer-types'
import {
  CustomModelInput,
  SynchronizedSpinner,
  contextForSelectedWindow,
  useExclusiveSessionControlMenu,
  waitForConfirmedModel
} from './agent-session-controls-support'

export type AgentSessionControlsProps = {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  isWorking: boolean
  context?: AgentSessionContextSnapshot
  canCompact?: boolean
  onCompact?: () => Promise<void>
  pickerRequest?: NativeChatOptionPickerRequest | null
  leading?: ReactNode
  className?: string
}

const CATEGORY_ORDER: Record<string, number> = {
  model: 0,
  thought_level: 1,
  model_config: 2,
  mode: 3
}

function sortedOptions(snapshot: readonly SessionOptionDescriptor[]): SessionOptionDescriptor[] {
  return [...snapshot].sort(
    (left, right) =>
      (CATEGORY_ORDER[left.category ?? ''] ?? 4) - (CATEGORY_ORDER[right.category ?? ''] ?? 4)
  )
}

function ContextDonut({ percent }: { percent: number | null }): React.JSX.Element {
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

function contextSummary(context: AgentSessionContextSnapshot): string {
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

function compactionLabel(context: AgentSessionContextSnapshot): string | null {
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

function DescriptorMenuRows(props: {
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

function currentOptionLabel(descriptor: SessionOptionDescriptor): string {
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

function AgentSessionControlsInner({
  surface,
  snapshot,
  isWorking,
  context = EMPTY_AGENT_SESSION_CONTEXT,
  canCompact = false,
  onCompact,
  pickerRequest,
  leading,
  className
}: AgentSessionControlsProps): React.JSX.Element | null {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const menu = useExclusiveSessionControlMenu()
  const descriptors = sortedOptions(snapshot)
  const model = descriptors.find((descriptor) => descriptor.category === 'model')
  const options = descriptors.filter((descriptor) => descriptor.category !== 'model')
  useEffect(() => {
    if (pickerRequest) {
      menu.setOpen(true)
    }
  }, [pickerRequest?.sequence])
  if (!surface && context.usedTokens === null && !canCompact) {
    return null
  }

  const run = async <T,>(key: string, call: () => Promise<T>): Promise<T | null> => {
    setPendingId(key)
    try {
      return await call()
    } catch (error) {
      toast.error(
        translate('components.native-chat.composer.optionUpdateFailed', 'Could not update option'),
        { description: error instanceof Error ? error.message : String(error) }
      )
      return null
    } finally {
      setPendingId(null)
    }
  }
  const modelLabel = model ? nativeChatModelPillLabel(model) : 'Session'
  const optionLabel = options.length > 0 ? nativeChatOptionsPillLabel(options) : null
  const displayedContext = contextForSelectedWindow(context, options)
  const summary = contextSummary(displayedContext)
  const compacting =
    pendingId === 'compact' ||
    context.compaction === 'requested' ||
    context.compaction === 'running'
  const setCustomModel = async (modelId: string): Promise<boolean> => {
    if (!surface) {
      return false
    }
    const confirmed = await run('model', async () => {
      const result = await surface.setOption('model', modelId)
      return await waitForConfirmedModel(surface, modelId, result.snapshot)
    })
    if (confirmed) {
      surface.addCustomModel?.(modelId)
    }
    return confirmed === true
  }

  return (
    <DropdownMenu
      open={menu.open}
      onOpenChange={(open) => {
        setTooltipOpen(false)
        menu.setOpen(open)
      }}
    >
      <Tooltip
        open={!menu.open && tooltipOpen}
        onOpenChange={(open) => setTooltipOpen(open && !menu.open)}
      >
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`${modelLabel}${optionLabel ? ` ${optionLabel}` : ''}. ${summary}`}
              onPointerLeave={() => setTooltipOpen(false)}
              className={cn(
                'max-w-72 gap-1.5 rounded-full bg-muted/50 px-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                className
              )}
            >
              {leading}
              {compacting ? (
                <SynchronizedSpinner />
              ) : (
                <ContextDonut percent={displayedContext.usedPercent} />
              )}
              <span className="truncate text-foreground">{modelLabel}</span>
              {optionLabel ? <span className="truncate">{optionLabel}</span> : null}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <div>{summary}</div>
          {compactionLabel(context) ? <div>{compactionLabel(context)}</div> : null}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        collisionPadding={8}
        align="end"
        className="w-64"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          setTooltipOpen(false)
        }}
      >
        <DropdownMenuLabel>{summary}</DropdownMenuLabel>
        {canCompact && onCompact ? (
          <DropdownMenuItem
            disabled={isWorking || pendingId !== null || compacting}
            onSelect={() => run('compact', onCompact)}
          >
            {compacting ? <SynchronizedSpinner /> : <Minimize2 />}
            {translate('components.native-chat.context.compact', 'Compact context')}
          </DropdownMenuItem>
        ) : null}
        {descriptors.length > 0 ? <DropdownMenuSeparator /> : null}
        {descriptors.map((descriptor) => {
          const reason = nativeChatSessionOptionDisabledReason(descriptor.disabledReason)
          return (
            <DropdownMenuSub
              key={`${descriptor.id}:${pickerRequest?.sequence ?? 'idle'}`}
              defaultOpen={pickerRequest?.id === descriptor.id}
            >
              <DropdownMenuSubTrigger className="grid grid-cols-[auto_minmax(0,1fr)_auto]">
                <span>{nativeChatSessionOptionLabel(descriptor)}</span>
                <span className="min-w-0 truncate text-right text-muted-foreground">
                  {currentOptionLabel(descriptor)}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                {reason && !descriptor.settable ? (
                  <DropdownMenuLabel className="font-normal">{reason}</DropdownMenuLabel>
                ) : null}
                {descriptor.valueSource === 'dispatched' ? (
                  <DropdownMenuLabel className="font-normal text-muted-foreground">
                    {translate(
                      'components.native-chat.composer.sentNotConfirmed',
                      'Sent to the agent — not confirmed'
                    )}
                  </DropdownMenuLabel>
                ) : null}
                <DescriptorMenuRows
                  descriptor={descriptor}
                  pending={isWorking || pendingId !== null}
                  setValue={(value) =>
                    surface &&
                    void run(descriptor.id, () => surface.setOption(descriptor.id, value))
                  }
                  invokeAction={() =>
                    surface && void run(descriptor.id, () => surface.invokeAction(descriptor.id))
                  }
                  setCustomModel={descriptor.category === 'model' ? setCustomModel : undefined}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const AgentSessionControls = memo(AgentSessionControlsInner)
