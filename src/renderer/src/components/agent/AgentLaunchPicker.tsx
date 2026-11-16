import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { shallow } from 'zustand/shallow'
import { sameAgentLaunchPickerModel } from './launch-menu/new-tab-agent-menu-model'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { AgentVariantIcon } from '@/components/agent/icons/AgentVariantIcon'
import { useTranslate } from '@/i18n/use-translate'
import { rowLabel } from './launch-menu/agent-menu-row-presentation'
import type { NewTabAgentMenuModel } from './launch-menu/new-tab-agent-menu-model'
import { useAgentPickerDraftScope } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { AgentLaunchPickerDropdown } from './AgentLaunchPickerDropdown'
import { AgentLaunchDefaultsFields } from './AgentLaunchDefaultsFields'
import type { AgentPickerChoice } from './agent-picker-search-rows'
import { agentPickerBlankTerminalMatches } from '@/lib/agent-catalog/agent-picker-search'
import {
  agentLaunchSetupSummary,
  rememberPickedAgentModel,
  usePickedAgentModel
} from './agent-launch-setup-state'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

const portalOrInline = (node: ReactNode, container: HTMLElement | null | undefined) =>
  container ? createPortal(node, container) : container === undefined ? node : null

/** A form's agent field. Forms own selection; the dropdown shares its setup card with the new-tab menu. */
export const AgentLaunchPicker = memo(
  function AgentLaunchPicker({
    model,
    entries: suppliedEntries,
    triggerLabel,
    draftScope,
    worktreeId,
    value,
    draftForEntry,
    agent,
    disabled,
    setupDisabled,
    portalContainer,
    emptyLabel,
    cli,
    choices,
    onSelectBlankTerminal,
    onTriggerEnter,
    onOpenChange,
    onCatalogOpen,
    defaultAgent,
    onSetDefault,
    launchDefaults,
    launchDefaultsContainer,
    onPick
  }: {
    model: NewTabAgentMenuModel
    entries?: AgentPickerEntry[]
    triggerLabel?: string
    draftScope?: object
    worktreeId?: string
    value?: AgentPickerDraft
    draftForEntry?: (entry: AgentPickerEntry) => AgentPickerDraft
    agent: AgentPickerEntry['agent'] | null
    disabled?: boolean
    /** Agents only: no models, effort or Open as. */
    setupDisabled?: boolean
    portalContainer?: HTMLElement | null
    emptyLabel?: string
    /** True when this launch is the terminal, so the closed field says "(CLI)". */
    cli?: boolean
    /** Non-agent choices, shown as full-width rows under the agents and listed by search. */
    choices?: readonly AgentPickerChoice[]
    onSelectBlankTerminal?: () => void
    onTriggerEnter?: () => void
    onOpenChange?: (open: boolean) => void
    /** Supplied entries own their catalogs; this says which agent's menu the user is viewing. */
    onCatalogOpen?: (agent: AgentPickerEntry['agent']) => void
    /** The saved default; with onSetDefault, right-clicking an agent offers "Set as default". */
    defaultAgent?: AgentPickerEntry['agent'] | 'blank' | null
    onSetDefault?: (agent: AgentPickerEntry['agent'] | 'blank') => void
    /** Settings forms: the picked agent's Permissions and Arguments, as fields under the picker. */
    launchDefaults?: boolean
    /** Renders those fields here instead, e.g. full width under a narrow picker column. */
    launchDefaultsContainer?: HTMLElement | null
    onPick: (
      agent: AgentPickerEntry['agent'],
      draft?: AgentPickerDraft,
      entry?: AgentPickerEntry,
      surface?: AgentPickerDraft['surface']
    ) => void
  }) {
    const t = useTranslate()
    const languageRevision = useUiLanguageRevision()
    const ownDraftScope = useAgentPickerDraftScope()
    const trigger = useRef<HTMLButtonElement>(null)
    const searchInput = useRef<HTMLInputElement>(null)
    const popupFocusReady = useRef(false)
    const setSearchInput = useCallback((input: HTMLInputElement | null) => {
      searchInput.current = input
      if (popupFocusReady.current) {
        input?.focus({ preventScroll: true })
      }
    }, [])
    const [open, setOpenState] = useState(false)
    // Why: typing on the closed trigger opens the menu with that key already in the search field.
    const [initialQuery, setInitialQuery] = useState('')
    const setOpen = useCallback(
      (next: boolean) => {
        if (!next) {
          popupFocusReady.current = false
          setInitialQuery('')
        }
        setOpenState(next)
        onOpenChange?.(next)
      },
      [onOpenChange]
    )
    const [selected, setSelected] = useState<AgentPickerEntry['agent']>()
    const observedEntries = useAgentLaunchPickerInventory(
      worktreeId,
      model,
      (open || Boolean(launchDefaults)) && !setupDisabled && !suppliedEntries,
      selected ?? agent ?? undefined
    )
    const entries = suppliedEntries ?? observedEntries
    const ownsCatalog = suppliedEntries !== undefined
    const selectAgent = useCallback(
      (next: AgentPickerEntry['agent']) => {
        setSelected(next)
        if (ownsCatalog) {
          onCatalogOpen?.(next)
        }
      },
      [ownsCatalog, onCatalogOpen]
    )
    const runLaunch = useCallback<ComponentProps<typeof AgentLaunchPickerMenu>['runLaunch']>(
      (row, draft, entry) =>
        onPick(
          row.agent,
          draft,
          entry,
          // Re-selecting an agent preserves the form's surface; a new chat row chooses Chat.
          !draft && row.agent !== agent && row.kind === 'chat' ? 'chat' : undefined
        ),
      [onPick, agent]
    )
    const catalogAgent = open && suppliedEntries ? (agent ?? undefined) : undefined
    useEffect(() => {
      if (catalogAgent) {
        onCatalogOpen?.(catalogAgent)
      }
    }, [catalogAgent, onCatalogOpen])
    const pick = useCallback<typeof onPick>(
      (picked, next, from, surface) => {
        if (next && from) {
          rememberPickedAgentModel(from, next)
        }
        onPick(picked, next, from, surface)
      },
      [onPick]
    )
    const entry = entries.find((entry) => entry.agent === agent)
    const draft = entry
      ? ((value?.agent === entry.agent ? value : undefined) ??
        draftForEntry?.(entry) ??
        agentPickerDraft(entry))
      : undefined
    // Why keyed on the draft's content and UI language: forms re-derive an equal draft on every
    // render, the summary rebuilds the agent's model catalog, and its labels are translated.
    const summaryKey =
      entry && draft && !setupDisabled && triggerLabel === undefined
        ? JSON.stringify([languageRevision, draft])
        : null
    const pickedModel = usePickedAgentModel(entry, draft?.choices.model)
    const summary = useMemo(() => {
      if (!entry || !summaryKey) {
        return ''
      }
      const [, parsed]: [unknown, AgentPickerDraft] = JSON.parse(summaryKey)
      return agentLaunchSetupSummary(entry, parsed, pickedModel).join(' · ')
    }, [entry, summaryKey, pickedModel])
    // Only a dropdown with Open as names how the agent runs, as Open as does.
    const surface =
      entry && !setupDisabled && !entry.textGeneration
        ? cli
          ? 'terminal'
          : (draft?.surface ?? entry.defaultSurface)
        : cli
          ? 'terminal'
          : undefined
    const agentLabel = agent
      ? surface === 'terminal'
        ? rowLabel({ kind: 'cli', agent }, t)
        : surface === 'chat'
          ? `${entry?.label ?? getAgentLabel(agent)} ${t('agentPicker.chatTag', '(Chat)')}`
          : (entry?.label ?? getAgentLabel(agent))
      : (emptyLabel ?? t('agentPicker.select', 'Select agent'))
    const close = useCallback(() => setOpen(false), [setOpen])
    const tabbed = model.state === 'settled' && !setupDisabled
    const blankTerminal: AgentPickerChoice | null = onSelectBlankTerminal
      ? {
          id: 'blank',
          label: t('auto.components.agent.AgentCombobox.986f946354', 'Blank Terminal'),
          icon: <Terminal className="size-4" />,
          matches: agentPickerBlankTerminalMatches,
          isDefault: defaultAgent === 'blank',
          onSetDefault: onSetDefault ? () => onSetDefault('blank') : undefined,
          onSelect: onSelectBlankTerminal
        }
      : null
    // A search result is a cmdk row, which does not close the menu as a menu item does.
    const extraChoices = [...(blankTerminal ? [blankTerminal] : []), ...(choices ?? [])].map(
      (choice) => ({
        ...choice,
        onSelect: () => {
          choice.onSelect()
          setOpen(false)
        }
      })
    )
    return (
      <div className="space-y-2">
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              type="button"
              data-agent-launch-picker-trigger="true"
              aria-label={t('agentPicker.select', 'Select agent')}
              variant="outline"
              className="w-full min-w-0"
              disabled={disabled || model.state !== 'settled'}
              onKeyDown={(event) => {
                if (open) {
                  return
                }
                if (event.key === 'Enter' && onTriggerEnter) {
                  event.preventDefault()
                  event.stopPropagation()
                  onTriggerEnter()
                  return
                }
                if (
                  model.state === 'settled' &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  event.key.length === 1 &&
                  /\S/.test(event.key)
                ) {
                  event.preventDefault()
                  setInitialQuery(event.key)
                  setOpen(true)
                }
              }}
            >
              {agent ? <AgentVariantIcon agent={agent} size={14} /> : null}
              <span className="min-w-0 flex-1 truncate text-left">
                {triggerLabel ?? agentLabel}
                {!triggerLabel && agent && summary ? (
                  <span className="text-muted-foreground"> · {summary}</span>
                ) : null}
              </span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            portalContainer={portalContainer}
            align="start"
            collisionPadding={tabbed ? 8 : undefined}
            variant={tabbed ? 'picker' : 'default'}
            onOpenAutoFocus={(event) => {
              popupFocusReady.current = true
              if (searchInput.current) {
                event.preventDefault()
                searchInput.current.focus({ preventScroll: true })
              }
            }}
            className={
              tabbed
                ? // Why 26rem: Codex's widest effort row plus Fast measures 404px; narrow windows cap it.
                  'w-(--radix-dropdown-menu-trigger-width) max-w-(--radix-dropdown-menu-content-available-width) min-w-[min(26rem,var(--radix-dropdown-menu-content-available-width))] overflow-hidden'
                : 'min-w-64'
            }
          >
            {tabbed ? (
              <AgentLaunchPickerDropdown
                entries={entries}
                agent={agent}
                value={value}
                draftForEntry={draftForEntry}
                draftScope={draftScope ?? ownDraftScope}
                disabled={disabled}
                initialQuery={initialQuery}
                searchInputRef={setSearchInput}
                defaultAgent={defaultAgent}
                onSetDefault={onSetDefault}
                onPaneChange={selectAgent}
                onPick={pick}
                onClose={close}
                choices={extraChoices}
              />
            ) : model.state === 'settled' ? (
              <AgentLaunchPickerMenu
                draftScope={draftScope ?? ownDraftScope}
                model={model}
                entries={entries}
                initialQuery={initialQuery}
                searchInputRef={setSearchInput}
                choices={choices}
                onSelectBlankTerminal={onSelectBlankTerminal}
                value={value}
                draftForEntry={draftForEntry}
                mode="select"
                disabled={disabled}
                setupDisabled
                onSelectAgent={selectAgent}
                defaultAgent={defaultAgent}
                onSetDefault={onSetDefault}
                runLaunch={runLaunch}
              />
            ) : (
              <DropdownMenuItem disabled>
                {t('agentPicker.select', 'Select agent')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {launchDefaults && entry && draft && !setupDisabled && !entry.textGeneration
          ? portalOrInline(
              <AgentLaunchDefaultsFields
                entry={entry}
                draft={draft}
                disabled={disabled}
                onCommit={(next, surface) => onPick(entry.agent, next, entry, surface)}
              />,
              launchDefaultsContainer
            )
          : null}
      </div>
    )
  },
  (a, b) =>
    sameAgentLaunchPickerModel(a.model, b.model) &&
    shallow({ ...a, model: undefined }, { ...b, model: undefined })
)
