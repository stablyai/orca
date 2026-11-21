// @protected-copy scope=file
// Picks a bot's permission, including for a bot made from someone else's link.
// The bot's agent with its model, effort and permissions: the agent picker, chat only, keeping a setup.
import { useCallback, useMemo, useState, type ComponentProps } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { useAgentPickerDraftScope } from '@/components/agent/AgentLaunchSetupButton'
import { useAgentLaunchPickerInventory } from '@/components/agent/use-agent-launch-picker-inventory'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { agentChatPermissionModes } from '../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import {
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { isBotAgent, type BotAgent } from '../../../../shared/bot-types'
import { botLaunchFromChoices, type BotLaunch } from '../../../../shared/bots/bot-launch'
import type { BotPermissionIntent } from './use-bot-agent-setup'

export type BotAgentSetup = {
  agent: BotAgent
  launch?: BotLaunch
  permissionMode?: AgentChatPermissionMode
}

type Projection = { signature: string; entry: AgentPickerEntry; draft: AgentPickerDraft }

/** The bot's permission override where `agent` offers it; otherwise the agent's default. */
function permissionOn(
  agent: string,
  mode: AgentChatPermissionMode | undefined
): AgentChatPermissionMode | undefined {
  return agentChatPermissionModes(agent)?.modes.find((offered) => offered === mode)
}

/** What a pick in the bot's picker keeps: the choices made, and nothing for what follows the defaults. */
export function botAgentSetupFromDraft(agent: BotAgent, draft: AgentPickerDraft): BotAgentSetup {
  const launch = botLaunchFromChoices(draft.choices)
  const { permissionMode } = draft.choices
  return {
    agent,
    ...(launch ? { launch } : {}),
    ...(isAgentChatPermissionMode(permissionMode) ? { permissionMode } : {})
  }
}

/** Each agent the host can run a bot on, as a chat that keeps its setup. */
function useBotAgentPickerEntries(
  observed: AgentPickerEntry[],
  choices: readonly BotAgent[],
  setup: BotAgentSetup,
  carried: AgentChatPermissionMode | undefined,
  withPermission: boolean
) {
  const t = useTranslate()
  const projections = useMemo(() => new WeakMap<AgentPickerEntry, Projection>(), [])
  const entries = observed
    .filter(
      (entry) => entry.surfaces.includes('chat') && choices.some((agent) => agent === entry.agent)
    )
    .map((entry): AgentPickerEntry => {
      const own = entry.agent === setup.agent
      // Another agent opens on its own defaults, keeping the bot's permission where it offers it.
      const permissionMode = permissionOn(entry.agent, own ? setup.permissionMode : carried)
      const signature = JSON.stringify([own && setup.launch, permissionMode, withPermission])
      const previous = projections.get(entry)
      if (previous && previous.signature === signature) {
        return previous.entry
      }
      const projected: AgentPickerEntry = {
        ...entry,
        surfaces: ['chat'],
        defaultSurface: 'chat',
        // A bot's chats take no terminal Arguments, so none may set or hide a choice here.
        arguments: '',
        keptSetup: withPermission
          ? {
              permissions: agentChatPermissionModes(entry.agent)?.modes ?? [],
              // As the bot's Settings names it.
              inheritLabel: t('settings.bots.permissionSameAsChats', 'Same as chats')
            }
          : {}
      }
      const projection: Projection = {
        signature,
        entry: projected,
        draft: {
          agent: entry.agent,
          surface: 'chat',
          choices: {
            ...(own && setup.launch?.model ? { model: setup.launch.model } : {}),
            options: own ? { ...setup.launch?.options } : {},
            ...(permissionMode ? { permissionMode } : {})
          }
        }
      }
      projections.set(entry, projection)
      projections.set(projected, projection)
      return projected
    })
  const draftForEntry = useCallback(
    (entry: AgentPickerEntry) => projections.get(entry)?.draft ?? agentPickerDraft(entry, 'chat'),
    [projections]
  )
  return { entries, draftForEntry }
}

/** A "Same as <bot>" row under the card: the choice that follows the bot rather than naming an agent. */
export type BotAgentLaunchInherit = {
  label: string
  /** What it runs now, under the label: "Claude Code · Opus 5.5". */
  detail?: string
  /** The agent whose icon the field shows while it is chosen; none when it can't say. */
  agent?: BotAgent
  chosen: boolean
  onChoose: () => void
}

export function BotAgentLaunchPicker({
  model,
  choices,
  value,
  worktreeId,
  withPermission = true,
  showChatDefaultHint = true,
  disabled,
  inherit,
  keptPermission,
  onChange
}: {
  /** The host's agent menu (`useBotAgentMenu`). */
  model: NewTabAgentMenuModel
  /** The agents the host has. */
  choices: readonly BotAgent[]
  value: BotAgentSetup
  /** The bot's folder workspace, where agents such as OMP list their models; none before the bot exists. */
  worktreeId?: string
  /** False where the bot's permission has its own control beside the picker. */
  withPermission?: boolean
  showChatDefaultHint?: boolean
  disabled?: boolean
  /** Offered under the card; while chosen, the field shows it instead of `value`. */
  inherit?: BotAgentLaunchInherit
  /** A bot from a link: the owner's permission, which another agent opens with in place of the one
   *  shown (the shown one may be this agent's fallback for it). */
  keptPermission?: BotPermissionIntent
  /** `permissionPicked` when the owner chose its permission (or cleared it), not only kept the shown one. */
  onChange: (setup: BotAgentSetup, permissionPicked?: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const carried =
    keptPermission === undefined
      ? value.permissionMode
      : keptPermission === 'inherit'
        ? undefined
        : keptPermission
  const [menuOpen, setMenuOpen] = useState(false)
  const [catalogAgent, setCatalogAgent] = useState<AgentPickerEntry['agent']>()
  const observed = useAgentLaunchPickerInventory(
    worktreeId,
    model,
    menuOpen,
    catalogAgent ?? value.agent
  )
  const { entries, draftForEntry } = useBotAgentPickerEntries(
    observed,
    choices,
    value,
    carried,
    withPermission
  )
  // A kept setup reseeds the panel's drafts from what the bot now has.
  const scope = useAgentPickerDraftScope(JSON.stringify(value))
  const onPick = useCallback<ComponentProps<typeof AgentLaunchPicker>['onPick']>(
    (agent, draft, _entry, _surface, permissionPicked) => {
      if (!isBotAgent(agent)) {
        return
      }
      if (draft) {
        onChange(botAgentSetupFromDraft(agent, draft), permissionPicked)
      } else if (agent !== value.agent) {
        // Another agent's row: its own defaults, and the bot's permission where it offers it.
        const permissionMode = permissionOn(agent, carried)
        onChange({ agent, ...(permissionMode ? { permissionMode } : {}) })
      }
    },
    [onChange, value.agent, carried]
  )
  const resetLabel = t('bots.new.useChatDefaults', 'Use chat defaults')
  const canReset = !inherit && Boolean(value.launch || (withPermission && value.permissionMode))
  const reset = () => {
    onChange(
      {
        agent: value.agent,
        ...(!withPermission && value.permissionMode ? { permissionMode: value.permissionMode } : {})
      },
      withPermission
    )
  }
  const extraChoice = inherit
    ? {
        id: 'inherit',
        label: inherit.detail ? `${inherit.label} · ${inherit.detail}` : inherit.label,
        icon: inherit.chosen ? <Check className="size-3.5" /> : undefined,
        onSelect: inherit.onChoose
      }
    : undefined
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <AgentLaunchPicker
        model={model}
        entries={entries}
        agent={inherit?.chosen ? (inherit.agent ?? null) : value.agent}
        {...(inherit?.chosen
          ? {
              triggerLabel: inherit.label,
              emptyLabel: inherit.label,
              triggerDetail: inherit.detail
            }
          : {})}
        draftScope={scope}
        draftForEntry={draftForEntry}
        disabled={disabled}
        selectAgentOnTab
        onOpenChange={setMenuOpen}
        onCatalogOpen={setCatalogAgent}
        onPick={onPick}
        choices={extraChoice ? [extraChoice] : undefined}
      />
      {showChatDefaultHint && !inherit && !value.launch ? (
        // Without its own model the picker shows the owner's chat default, which the bot didn't choose.
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.new.usingChatDefault',
            'Using your chat default. Background runs use your Agents setting.'
          )}
        </p>
      ) : null}
      {canReset ? (
        <Button
          type="button"
          variant="link"
          size="inlineText"
          className="self-start"
          disabled={disabled}
          onClick={reset}
        >
          {resetLabel}
        </Button>
      ) : null}
    </div>
  )
}
