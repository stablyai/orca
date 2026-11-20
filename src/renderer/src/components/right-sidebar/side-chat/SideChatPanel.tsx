import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { NativeChatStructuredSession } from '@/components/native-chat/NativeChatStructuredSession'
import { requestNativeChatComposerFocus } from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import {
  nativeChatAuxiliaryParentKey,
  nativeChatAuxiliaryTabId,
  selectNativeChatAuxiliaryActiveChild,
  type NativeChatAuxiliaryChild
} from '@/store/slices/right-sidebar/native-chat-auxiliary-state'
import {
  closeNativeChatAuxiliaryChild,
  ensureNativeChatAuxiliaryChildRoutable,
  openNativeChatAuxiliary,
  useNativeChatAuxiliaryConversation,
  useNativeChatAuxiliaryAvailability
} from './native-chat-auxiliary-chat'
import { useActiveNativeChatAuxiliaryParent } from './native-chat-auxiliary-parent'
import {
  consumeNativeChatAuxiliaryFocus,
  useNativeChatAuxiliaryFocusIntent
} from './native-chat-auxiliary-focus-intent'

/** One focused source chat's unlisted children; tabs live here, never in the main layout. */
export function SideChatPanel({ isVisible }: { isVisible: boolean }): React.JSX.Element {
  const t = useTranslate()
  const parent = useActiveNativeChatAuxiliaryParent()
  const conversation = useNativeChatAuxiliaryConversation(parent)
  const availability = useNativeChatAuxiliaryAvailability(parent)
  const activeChild = useAppStore((state) =>
    parent ? selectNativeChatAuxiliaryActiveChild(state, parent) : null
  )
  const focusIntent = useNativeChatAuxiliaryFocusIntent()
  const parentKey = parent ? nativeChatAuxiliaryParentKey(parent) : null
  const [paneFocused, setPaneFocused] = useState(
    () => activeChild !== null && focusIntent === activeChild.sessionId
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const guardedChildren = useRef(new Set<string>())
  const lastParentKey = useRef(parentKey)

  // Only an explicit open's one-shot claim reveals a child; a passive tab reopen never does.
  useEffect(() => {
    if (!focusIntent || focusIntent !== activeChild?.sessionId) {
      return
    }
    setPaneFocused(true)
    consumeNativeChatAuxiliaryFocus(focusIntent)
  }, [activeChild?.sessionId, focusIntent])

  useEffect(() => {
    // A source switch deselects the panel; switching back restores the remembered child.
    if (lastParentKey.current === parentKey) {
      return
    }
    lastParentKey.current = parentKey
    if (focusIntent) {
      consumeNativeChatAuxiliaryFocus(focusIntent)
    }
    setPaneFocused(false)
  }, [focusIntent, parentKey])

  useEffect(() => {
    if (!activeChild || guardedChildren.current.has(activeChild.sessionId)) {
      return
    }
    guardedChildren.current.add(activeChild.sessionId)
    void ensureNativeChatAuxiliaryChildRoutable(activeChild)
  }, [activeChild])

  useEffect(() => {
    if (!isVisible) {
      setPaneFocused(false)
    }
  }, [isVisible])

  const openNewChild = (): void => {
    if (!parent) {
      return
    }
    setPaneFocused(true)
    void openNativeChatAuxiliary({ parent }).then((result) => {
      if ('refused' in result) {
        toast.error(result.refused)
      }
    })
  }

  const selectChild = (child: NativeChatAuxiliaryChild): void => {
    if (!parent) {
      return
    }
    setPaneFocused(true)
    useAppStore
      .getState()
      .setActiveNativeChatAuxiliaryChild(nativeChatAuxiliaryParentKey(parent), child.sessionId)
    requestNativeChatComposerFocus(nativeChatAuxiliaryTabId(child.sessionId))
  }

  const closeChild = (child: NativeChatAuxiliaryChild): void => {
    closeNativeChatAuxiliaryChild(child)
  }

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-side-chat-panel=""
      data-side-chat-parent-session={parent?.sessionId}
      data-side-chat-active-child={activeChild?.sessionId}
      onPointerDownCapture={() => setPaneFocused(true)}
      onFocusCapture={() => setPaneFocused(true)}
      onBlurCapture={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
          setPaneFocused(false)
        }
      }}
    >
      <div className="flex h-[32px] min-h-[32px] items-center border-b border-border bg-sidebar">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-sleek">
          {conversation?.children.map((child) => {
            const active = child.sessionId === activeChild?.sessionId
            return (
              <div
                key={child.sessionId}
                className="group flex h-full shrink-0 items-center border-r border-border/60"
              >
                <button
                  type="button"
                  className={
                    active
                      ? 'h-full max-w-40 truncate bg-accent px-2 text-[11px] font-medium text-accent-foreground'
                      : 'h-full max-w-40 truncate px-2 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  }
                  data-side-chat-tab={child.sessionId}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => selectChild(child)}
                >
                  {t('components.rightSidebar.sideChat.tabTitle', 'Side chat {{number}}', {
                    number: child.titleNumber
                  })}
                </button>
                <button
                  type="button"
                  className="mr-1 flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={t(
                    'components.rightSidebar.sideChat.close',
                    'Close side chat {{number}}',
                    { number: child.titleNumber }
                  )}
                  data-side-chat-close={child.sessionId}
                  onClick={() => closeChild(child)}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40"
          aria-label={t('components.rightSidebar.sideChat.new', 'New side chat')}
          title={availability.reason ?? undefined}
          data-side-chat-new=""
          disabled={!availability.available}
          onClick={openNewChild}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {activeChild && parent ? (
        <div className="flex min-h-0 flex-1 flex-col" data-side-chat-child={activeChild.sessionId}>
          <NativeChatStructuredSession
            tabId={nativeChatAuxiliaryTabId(activeChild.sessionId)}
            sessionId={activeChild.sessionId}
            target={activeChild.target}
            agent={activeChild.agent}
            isVisible={isVisible}
            isFocusedGroup={paneFocused && isVisible}
            auxiliaryOwnerWorktreeId={parent.worktreeId}
            auxiliaryParentTabId={parent.tabId}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
          <p className="text-[11px] text-muted-foreground">
            {availability.reason ??
              t(
                'components.rightSidebar.sideChat.empty',
                'Ask about this conversation without interrupting it.'
              )}
          </p>
          {/* A fixed entry stays usable for a supported source even while an old child is blocked. */}
          {availability.available ? (
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent"
              data-side-chat-empty-new=""
              onClick={openNewChild}
            >
              {t('components.rightSidebar.sideChat.new', 'New side chat')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

export default SideChatPanel
