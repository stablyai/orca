import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Paperclip } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'
import {
  makeNativeChatPaneFileDropHandlers,
  type NativeChatPaneDropClaim
} from './native-chat-pane-file-drop'

/** A mounted composer's live drop claim. The getter is what the surface reads at
 *  event time, so a guarded composer answers for the drag in front of it. */
export type NativeChatPaneDropRegistration = {
  getClaim: () => NativeChatPaneDropClaim
  scopeKey: string
}

type RegisterPaneDropClaim = (registration: NativeChatPaneDropRegistration) => () => void

const NativeChatPaneFileDropContext = createContext<RegisterPaneDropClaim | null>(null)

/**
 * Publishes the composer's drop claim to the pane around it, so the whole chat
 * pane — not just the input box — is the target a file can be dropped on.
 */
export function useNativeChatPaneFileDropClaim(claim: NativeChatPaneDropClaim): void {
  const register = useContext(NativeChatPaneFileDropContext)
  const claimRef = useRef(claim)
  useLayoutEffect(() => {
    claimRef.current = claim
  })
  const { scopeKey, disabled } = claim
  const registration = useMemo<NativeChatPaneDropRegistration>(
    () => ({ getClaim: () => claimRef.current, scopeKey }),
    [scopeKey]
  )
  // A guard transition ends the current hover before the next paint.
  useLayoutEffect(() => register?.(registration), [disabled, register, registration])
}

export function NativeChatPaneFileDropSurface({
  className,
  children
}: {
  className: string
  children: React.ReactNode
}): React.JSX.Element {
  const [registration, setRegistration] = useState<NativeChatPaneDropRegistration | null>(null)
  const [isDragActive, setIsDragActive] = useState(false)
  const register = useMemo<RegisterPaneDropClaim>(
    () => (next) => {
      setRegistration(next)
      return () => {
        setRegistration((current) => (current === next ? null : current))
        setIsDragActive(false)
      }
    },
    []
  )
  const handlers = useMemo(
    () =>
      makeNativeChatPaneFileDropHandlers({
        getClaim: () => registration?.getClaim() ?? null,
        setDragActive: setIsDragActive
      }),
    [registration]
  )
  // Subscribe before hover renders: preload can consume a drop before that commit.
  useLayoutEffect(() => {
    if (!registration) {
      return
    }
    const clear = (): void => setIsDragActive(false)
    document.addEventListener('drop', clear, true)
    document.addEventListener('dragend', clear, true)
    return () => {
      document.removeEventListener('drop', clear, true)
      document.removeEventListener('dragend', clear, true)
    }
  }, [registration])

  return (
    <NativeChatPaneFileDropContext.Provider value={register}>
      <div
        className={className}
        // Why: the preload route reads the nearest marker, so publishing the
        // composer's scope here is what widens an OS drop to the whole pane.
        data-native-file-drop-target={registration ? NATIVE_FILE_DROP_TARGET.composer : undefined}
        data-composer-scope-key={registration?.scopeKey}
        {...handlers}
      >
        {children}
        {isDragActive ? <NativeChatPaneFileDropOverlay /> : null}
      </div>
    </NativeChatPaneFileDropContext.Provider>
  )
}

function NativeChatPaneFileDropOverlay(): React.JSX.Element {
  return (
    <div
      data-native-chat-drop-overlay="true"
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/80"
    >
      <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-foreground/30 bg-card px-8 py-5 text-center shadow-floating">
        <span className="mb-1 flex size-9 items-center justify-center rounded-full bg-foreground/10">
          <Paperclip className="size-4.5" />
        </span>
        <span className="text-sm font-medium">
          {translate('components.native-chat.drop.title', 'Drop to attach to this chat')}
        </span>
        <span className="text-xs text-muted-foreground">
          {translate(
            'components.native-chat.drop.subtitle',
            'Files are added to your message as paths the agent can read.'
          )}
        </span>
      </div>
    </div>
  )
}
