import { Pencil, Plus, X } from 'lucide-react'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { resolveUnifiedTabLabel } from '../../../../shared/workspace-layout/tab-groups/tab-title-resolution'
import { useAppStore } from '../../store'
import { useTranslate } from '@/i18n/use-translate'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { agentTypeToIconAgent } from '../../../../shared/agent-status/presentation/agent-type-icon-agent'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useSortableTabRename } from '../tab-bar/terminal-tabs/use-sortable-tab-rename'
import { QuickLaunchAgentMenuItems } from '../agent/launch-menu/AgentMenuItems'
import { activateNativeChatAgentLaunchTab } from '@/lib/activate-native-chat-agent-launch-tab'
import { cn } from '@/lib/class-names'

export function ChatPanelHeader({
  chats,
  activeTabId,
  worktreeId,
  groupId,
  onActivate,
  onClose,
  allowClose = true,
  insetWindowControls = false
}: {
  chats: Tab[]
  activeTabId: string
  worktreeId: string
  groupId: string
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  /** False hides the close button so a pinned column keeps its last chat. */
  allowClose?: boolean
  /** Keeps header actions clear of the fixed Windows/Linux window controls. */
  insetWindowControls?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const generatedTitles = useAppStore((state) => state.settings?.tabAutoGenerateTitle === true)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const closeLabel = t('chatPanel.close', 'Close chat')
  const chatLabel = t('chatPanel.title', 'Chat')
  const renameLabel = t('chatPanel.rename', 'Rename chat')
  const newChatLabel = t('chatPanel.newChat', 'New chat')
  const active = chats.find((tab) => tab.id === activeTabId)
  return (
    <div
      className="flex h-full min-w-0 items-center gap-2 px-2 [-webkit-app-region:no-drag]"
      style={
        insetWindowControls ? { paddingRight: 'var(--window-controls-width, 0px)' } : undefined
      }
      data-chat-panel-header=""
      data-chat-panel-active-tab-id={activeTabId}
    >
      <span
        className="inline-flex shrink-0"
        data-agent-icon={active?.agentSessionAgent}
        aria-hidden="true"
      >
        <AgentIcon agent={agentTypeToIconAgent(active?.agentSessionAgent)} size={14} />
      </span>
      {active ? (
        <ChatPanelTitle
          key={active.id}
          active={active}
          chats={chats}
          generatedTitles={generatedTitles}
          chatLabel={chatLabel}
          renameLabel={renameLabel}
          onActivate={onActivate}
          onSetCustomTitle={setTabCustomTitle}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{chatLabel}</span>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={newChatLabel} className="shrink-0">
                <Plus />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{newChatLabel}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" side="bottom" className="w-56">
          <DropdownMenuLabel>{newChatLabel}</DropdownMenuLabel>
          <QuickLaunchAgentMenuItems
            worktreeId={worktreeId}
            groupId={groupId}
            onFocusTerminal={activateNativeChatAgentLaunchTab}
            launchSource="native_chat"
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {allowClose ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={closeLabel}
              onClick={() => onClose(activeTabId)}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

function ChatPanelTitle({
  active,
  chats,
  generatedTitles,
  chatLabel,
  renameLabel,
  onActivate,
  onSetCustomTitle
}: {
  active: Tab
  chats: Tab[]
  generatedTitles: boolean
  chatLabel: string
  renameLabel: string
  onActivate: (tabId: string) => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
}): React.JSX.Element {
  const displayTitle = resolveUnifiedTabLabel(active, generatedTitles, chatLabel)
  const {
    isEditing,
    renameValue,
    setRenameValue,
    handleRenameOpen,
    commitRename,
    cancelRename,
    setRenameInputElement
  } = useSortableTabRename({
    tabId: active.id,
    title: displayTitle,
    customTitle: active.customLabel,
    onSetCustomTitle
  })

  return (
    <>
      {isEditing ? (
        // Inline title editor: same type and position as the static title, no box
        // chrome; caret plus text selection carries the editing affordance.
        <ImeInput
          ref={setRenameInputElement}
          data-tab-rename-input="true"
          data-chat-rename-input="true"
          value={renameValue}
          aria-label={renameLabel}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (isImeCompositionKeyDown(event)) {
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelRename()
            }
          }}
          className="h-6 min-w-0 flex-1 truncate bg-transparent px-0 text-xs font-medium text-foreground caret-primary outline-none selection:bg-primary/20 placeholder:text-muted-foreground/50 focus-visible:outline-none"
          spellCheck={false}
        />
      ) : chats.length > 1 ? (
        <ChatPanelTabStrip
          chats={chats}
          activeTabId={active.id}
          generatedTitles={generatedTitles}
          chatLabel={chatLabel}
          onActivate={onActivate}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={displayTitle}>
          {displayTitle}
        </span>
      )}
      {isEditing ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={renameLabel}
              onClick={handleRenameOpen}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{renameLabel}</TooltipContent>
        </Tooltip>
      )}
    </>
  )
}

/** Horizontal strip for multi-session chat panels: each sibling chat gets a
 *  click-to-switch chip with its own agent icon. Narrow columns clip the
 *  strip but the chips shrink to stay reachable. */
function ChatPanelTabStrip({
  chats,
  activeTabId,
  generatedTitles,
  chatLabel,
  onActivate
}: {
  chats: Tab[]
  activeTabId: string
  generatedTitles: boolean
  chatLabel: string
  onActivate: (tabId: string) => void
}): React.JSX.Element {
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
      role="tablist"
      aria-label={chatLabel}
    >
      {chats.map((tab) => {
        const isActive = tab.id === activeTabId
        const label = resolveUnifiedTabLabel(tab, generatedTitles, chatLabel)
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            title={label}
            onClick={() => onActivate(tab.id)}
            className={cn(
              'flex h-6 min-w-0 max-w-40 shrink items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors',
              isActive
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <span
              className="inline-flex shrink-0"
              data-agent-icon={tab.agentSessionAgent}
              aria-hidden="true"
            >
              <AgentIcon agent={agentTypeToIconAgent(tab.agentSessionAgent)} size={12} />
            </span>
            <span className="min-w-0 truncate">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
