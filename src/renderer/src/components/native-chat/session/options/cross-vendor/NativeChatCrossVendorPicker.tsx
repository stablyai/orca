import { useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentSessionModelOption } from '../../../../../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { NativeChatSessionOptionChoiceBody } from '../controls/NativeChatSessionOptionChoiceBody'
import type { CrossVendorModels } from './use-native-chat-cross-vendor-catalog'
import {
  useNativeChatCrossVendor,
  type NativeChatCrossVendorControl
} from './native-chat-cross-vendor-context'
import { useNativeChatCrossVendorCatalog } from './use-native-chat-cross-vendor-catalog'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** The vendor column: the chat's own agent first, then every other agent that opens as a chat here. */
export function NativeChatVendorRail({
  vendors,
  selected,
  currentAgent,
  onSelect
}: {
  vendors: readonly TuiAgent[]
  selected: string
  currentAgent: string
  onSelect: (agent: TuiAgent) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label={t('components.native-chat.crossVendor.vendors', 'Agents')}
      className="flex shrink-0 flex-col gap-0.5 border-r border-border p-1"
    >
      {vendors.map((agent) => {
        const label = structuredAgentLabel(agent)
        return (
          <Tooltip key={agent}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="tab"
                aria-selected={agent === selected}
                aria-label={label}
                data-cross-vendor-agent={agent}
                onClick={() => onSelect(agent)}
                className={cn(
                  'relative flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  agent === selected && 'bg-accent text-accent-foreground'
                )}
              >
                <AgentIcon agent={agent} size={16} />
                {agent === currentAgent ? (
                  <span className="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-primary" />
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={4}>
              {agent === currentAgent
                ? t('components.native-chat.crossVendor.currentAgent', '{{agent}} · this chat', {
                    agent: label
                  })
                : label}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** Another vendor's models; picking one moves the conversation to that agent in this tab. */
export function NativeChatOtherVendorModels({
  agent,
  models,
  control
}: {
  agent: TuiAgent
  models: CrossVendorModels | undefined
  control: NativeChatCrossVendorControl
}): React.JSX.Element {
  const t = useTranslate()
  const label = structuredAgentLabel(agent)
  const [picked, setPicked] = useState<AgentSessionModelOption | null>(null)
  const busy = control.switching !== null
  const blocked = control.blockedReason
  const switchTo = (model?: AgentSessionModelOption, effort?: string): void => {
    if (busy || blocked) {
      return
    }
    control.switchTo(agent, model?.id, effort)
  }
  const efforts = picked ? (picked.chatEfforts ?? picked.efforts) : []
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
        {t(
          'components.native-chat.crossVendor.hint',
          'Continue this conversation with {{agent}}. Earlier messages stay here and are shared as context.',
          { agent: label }
        )}
      </div>
      {blocked ? <div className="px-3 pb-1 text-xs text-muted-foreground">{blocked}</div> : null}
      {models === undefined || models.state === 'loading' ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t('components.native-chat.crossVendor.loadingModels', 'Loading {{agent}} models…', {
            agent: label
          })}
        </div>
      ) : models.state === 'unknown' ? (
        <div className="flex flex-col gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {models.reason ??
              t(
                'components.native-chat.crossVendor.modelsUnknown',
                "{{agent}} didn't list its models; it starts with its default.",
                { agent: label }
              )}
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || Boolean(blocked)}
            onClick={() => switchTo()}
          >
            {t('components.native-chat.crossVendor.switchDefault', 'Switch to {{agent}}', {
              agent: label
            })}
            <ArrowRight />
          </Button>
        </div>
      ) : (
        <Command surface="inline" density="menu" label={label}>
          <CommandInput
            placeholder={t('components.native-chat.composer.searchModels', 'Search models…')}
          />
          <CommandList className="max-h-[min(233px,50vh)]" aria-busy={busy}>
            <CommandEmpty>
              {t('components.native-chat.composer.noModelsMatch', 'No models match your search.')}
            </CommandEmpty>
            <CommandGroup>
              {models.models.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.label, model.description ?? '']}
                  selection="palette"
                  disabled={busy || Boolean(blocked)}
                  aria-current={picked?.id === model.id || undefined}
                  data-cross-vendor-model={model.id}
                  onSelect={() => {
                    const choices = model.chatEfforts ?? model.efforts
                    if (choices.length > 1) {
                      setPicked(model)
                    } else {
                      switchTo(model)
                    }
                  }}
                >
                  <NativeChatSessionOptionChoiceBody
                    label={model.label}
                    description={model.description}
                  />
                  {control.switching === agent && picked?.id === model.id ? (
                    <Loader2 className="ml-auto size-3.5 animate-spin" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      )}
      {picked && efforts.length > 1 ? (
        <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {t('components.native-chat.crossVendor.effortFor', 'Reasoning for {{model}}', {
              model: picked.label
            })}
          </span>
          <div className="flex flex-wrap gap-1">
            {efforts.map((choice) => (
              <Button
                key={choice.value}
                type="button"
                size="xs"
                variant={choice.value === (picked.defaultEffort ?? '') ? 'secondary' : 'outline'}
                disabled={busy || Boolean(blocked)}
                data-cross-vendor-effort={choice.value}
                onClick={() => switchTo(picked, choice.value)}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The model menu's body beside the vendor column; `children` is the chat's own agent's menu. */
export function NativeChatCrossVendorFrame({
  open,
  children
}: {
  open: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const control = useNativeChatCrossVendor()
  const catalog = useNativeChatCrossVendorCatalog({
    open: open && control !== null,
    worktreeId: control?.worktreeId ?? null,
    target: control?.target ?? LOCAL_TARGET,
    currentAgent: control?.currentAgent ?? '',
    botOnly: control?.botOnly ?? false
  })
  const [pick, setPick] = useState<TuiAgent | null>(null)
  if (!control) {
    return <>{children}</>
  }
  const vendors = catalog.vendors ?? []
  const shown = pick && vendors.includes(pick) ? pick : null
  const other = shown && shown !== control.currentAgent ? shown : null
  return (
    <div className="flex min-h-0 min-w-0">
      {vendors.length > 1 ? (
        <NativeChatVendorRail
          vendors={vendors}
          selected={shown ?? control.currentAgent}
          currentAgent={control.currentAgent}
          onSelect={setPick}
        />
      ) : null}
      {other ? (
        <NativeChatOtherVendorModels
          key={other}
          agent={other}
          models={catalog.models[other]}
          control={control}
        />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      )}
    </div>
  )
}
