import { memo, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from '../native-chat/native-chat-session-option-labels'
import type { NativeChatOptionPickerRequest } from '../native-chat/native-chat-composer-types'
import {
  SynchronizedSpinner,
  contextForSelectedWindow,
  useExclusiveSessionControlMenu,
  waitForConfirmedModel
} from './agent-session-controls-support'
import {
  compactionLabel,
  ContextDonut,
  contextSummary,
  currentOptionLabel,
  DescriptorMenuRows
} from './agent-session-control-menu-content'

export type AgentSessionControlsProps = {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  isWorking: boolean
  context?: AgentSessionContextSnapshot
  canCompact?: boolean
  onCompact?: () => Promise<void>
  onOpen?: () => void
  pickerRequest?: NativeChatOptionPickerRequest | null
  leading?: ReactNode
  fallbackModelLabel?: string | null
  fallbackOptionLabel?: string | null
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

function AgentSessionControlsInner({
  surface,
  snapshot,
  isWorking,
  context = EMPTY_AGENT_SESSION_CONTEXT,
  canCompact = false,
  onCompact,
  onOpen,
  pickerRequest,
  leading,
  fallbackModelLabel,
  fallbackOptionLabel,
  className
}: AgentSessionControlsProps): React.JSX.Element | null {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const { open: menuOpen, setOpen: setMenuOpen } = useExclusiveSessionControlMenu()
  const descriptors = sortedOptions(snapshot)
  const model = descriptors.find((descriptor) => descriptor.category === 'model')
  const options = descriptors.filter((descriptor) => descriptor.category !== 'model')
  useEffect(() => {
    if (pickerRequest) {
      setMenuOpen(true)
    }
  }, [pickerRequest, setMenuOpen])
  if (!surface && context.usedTokens === null && !canCompact && !leading) {
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
  const modelLabel =
    model?.kind.type === 'select' && model.kind.currentValue && model.valueSource !== 'unknown'
      ? nativeChatModelPillLabel(model)
      : (fallbackModelLabel ?? (model ? nativeChatModelPillLabel(model) : 'Session'))
  const optionLabel = options.some((option) => option.valueSource !== 'unknown')
    ? nativeChatOptionsPillLabel(
        options,
        model?.kind.type === 'select' &&
          model.kind.currentValue &&
          model.kind.currentValue === context.model
          ? context.effort
          : null
      )
    : (fallbackOptionLabel ?? null)
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
      open={menuOpen}
      onOpenChange={(open) => {
        setTooltipOpen(false)
        if (open) {
          onOpen?.()
        }
        setMenuOpen(open)
      }}
    >
      <Tooltip
        open={!menuOpen && tooltipOpen}
        onOpenChange={(open) => setTooltipOpen(open && !menuOpen)}
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
                {descriptor.description ? (
                  <DropdownMenuLabel className="font-normal">
                    {descriptor.description}
                  </DropdownMenuLabel>
                ) : null}
                {reason && !descriptor.settable ? (
                  <DropdownMenuLabel className="font-normal">{reason}</DropdownMenuLabel>
                ) : null}
                {sessionOptionDispatchUnconfirmed(descriptor) ? (
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
