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

/** Each agent the host can run a bot on, as a chat that keeps its setup; the bot's own agent opens
 *  on what the bot saved. One it lacks is listed greyed with its reason. */
function useBotAgentPickerEntries(
  observed: AgentPickerEntry[],
  choices: readonly BotAgent[],
  setup: BotAgentSetup,
  withPermission: boolean
) {
  const t = useTranslate()
  const projections = useMemo(() => new WeakMap<AgentPickerEntry, Projection>(), [])
  const entries = observed
    .filter(
      (entry) =>
        choices.some((agent) => agent === entry.agent) ||
        (isBotAgent(entry.agent) && entry.rows.some((row) => row.kind === 'chat-unavailable'))
    )
    .map((entry): AgentPickerEntry => {
      // One the host lacks stays listed, greyed, with its reason.
      if (!choices.some((agent) => agent === entry.agent)) {
        return entry.surfaces.length ? { ...entry, surfaces: [] } : entry
      }
      const own = entry.agent === setup.agent
      // Another agent opens on its own defaults, keeping the bot's permission where it offers it.
      const permissionMode = permissionOn(entry.agent, setup.permissionMode)
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
  withPermission = true,
  disabled,
  inherit,
  onChange
}: {
  /** The host's agent menu (`useBotAgentMenu`). */
  model: NewTabAgentMenuModel
  /** The agents the host has. */
  choices: readonly BotAgent[]
  value: BotAgentSetup
  /** False where the bot's permission has its own control beside the picker. */
  withPermission?: boolean
  disabled?: boolean
  /** Offered under the card; while chosen, the field shows it instead of `value`. */
  inherit?: BotAgentLaunchInherit
  onChange: (setup: BotAgentSetup) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [catalogAgent, setCatalogAgent] = useState<AgentPickerEntry['agent']>()
  const observed = useAgentLaunchPickerInventory(
    undefined,
    model,
    menuOpen,
    catalogAgent ?? value.agent
  )
  const { entries, draftForEntry } = useBotAgentPickerEntries(
    observed,
    choices,
    value,
    withPermission
  )
  // A kept setup reseeds the panel's drafts from what the bot now has.
  const scope = useAgentPickerDraftScope(JSON.stringify(value))
  const onPick = useCallback<ComponentProps<typeof AgentLaunchPicker>['onPick']>(
    (agent, draft) => {
      if (!isBotAgent(agent)) {
        return
      }
      if (draft) {
        onChange(botAgentSetupFromDraft(agent, draft))
      } else if (agent !== value.agent) {
        // Another agent's row: its own defaults, and the bot's permission where it offers it.
        const permissionMode = permissionOn(agent, value.permissionMode)
        onChange({ agent, ...(permissionMode ? { permissionMode } : {}) })
      }
    },
    [onChange, value.agent, value.permissionMode]
  )
  return (
    <div className="flex flex-col gap-1">
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
        onOpenChange={setMenuOpen}
        onCatalogOpen={setCatalogAgent}
        onPick={onPick}
        choices={
          inherit
            ? [
                {
                  id: 'inherit',
                  label: inherit.detail ? `${inherit.label} · ${inherit.detail}` : inherit.label,
                  icon: inherit.chosen ? <Check className="size-3.5" /> : undefined,
                  onSelect: inherit.onChoose
                }
              ]
            : undefined
        }
      />
      {inherit || value.launch ? null : (
        // Without its own model the picker shows the owner's chat default, which the bot didn't choose.
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.new.usingChatDefault',
            'Using your chat default. Background runs use your Agents setting.'
          )}
        </p>
      )}
      {/* With a leading item, that item is the way back. */}
      {!inherit && (value.launch || (withPermission && value.permissionMode)) ? (
        // The way back from a pick: the bot's chats start on the chat defaults again, for
        // everything this picker sets (Settings keeps the permission on its own row).
        <Button
          type="button"
          variant="link"
          size="inlineText"
          className="self-start"
          disabled={disabled}
          onClick={() =>
            onChange(
              withPermission
                ? { agent: value.agent }
                : {
                    agent: value.agent,
                    ...(value.permissionMode ? { permissionMode: value.permissionMode } : {})
                  }
            )
          }
        >
          {t('bots.new.useChatDefaults', 'Use chat defaults')}
        </Button>
      ) : null}
    </div>
  )
}
