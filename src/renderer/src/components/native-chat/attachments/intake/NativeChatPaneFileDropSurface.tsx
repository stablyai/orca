import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Paperclip } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { toast } from 'sonner'
import {
  createOsFileDropSequence,
  useOsFileDropOwner
} from '@/lib/files/drop/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/files/drop/native-file-drop-rejection-message'
import { prepareOsFileDropPaths } from '@/lib/files/drop/os-file-drop-preparation'
import { droppedWebImageUrl } from '@/lib/files/drop/web-image-drag'
import { readBrowserAttachmentFile } from '@/lib/files/drop/browser-attachment-files'
import type { PreparedDroppedPaths } from '../../../../../../shared/file-import/native-file-drop-preparation'
import {
  makeNativeChatPaneFileDropHandlers,
  type NativeChatPaneDropClaim,
  type CapturedNativeChatDrop
} from './native-chat-pane-file-drop'

/** Read the mounted composer’s claim at event time so guard changes apply to the current drag. */
export type NativeChatPaneDropRegistration = {
  getClaim: () => NativeChatPaneDropClaim
  destinationKey: string
  focusScopeKey?: string
}

type RegisterPaneDropClaim = ((registration: NativeChatPaneDropRegistration) => () => void) & {
  clearHover?: () => void
}

const NativeChatPaneFileDropContext = createContext<RegisterPaneDropClaim | null>(null)

async function deliverDroppedPaths(
  prepared: PreparedDroppedPaths,
  destination: CapturedNativeChatDrop | undefined
): Promise<void> {
  for (const failure of prepared.failures) {
    const message = getNativeFileDropRejectionMessage(failure)
    toast.error(message.title, { description: message.description })
  }
  await destination?.(prepared.paths)
}

/** Save a web page's dragged image, then attach it as a dropped file. */
async function dropWebImage(html: string, destination: CapturedNativeChatDrop): Promise<void> {
  const url = droppedWebImageUrl(html)
  const path = url ? await window.api.ui.saveDroppedWebImage(url).catch(() => null) : null
  // The web client holds the image as a browser file, which has no path to prepare.
  const prepared: PreparedDroppedPaths = !path
    ? {
        paths: [],
        failures: [{ target: 'rejected', reason: 'unresolved-paths', pathCount: 1, byteLength: 0 }]
      }
    : readBrowserAttachmentFile(path)
      ? { paths: [path], failures: [] }
      : await prepareOsFileDropPaths([path], destination.preparationConsumer ?? 'agent')
  await deliverDroppedPaths(prepared, destination)
}

/** Publish the composer’s claim so the whole pane accepts its file drops. */
export function useNativeChatPaneFileDropClaim(claim: NativeChatPaneDropClaim): void {
  const register = useContext(NativeChatPaneFileDropContext)
  const claimRef = useRef(claim)
  useLayoutEffect(() => {
    claimRef.current = claim
  })
  useLayoutEffect(() => {
    if (claim.disabled) {
      register?.clearHover?.()
    }
  }, [claim.disabled, register])
  const { destinationKey, focusScopeKey } = claim
  const registration = useMemo<NativeChatPaneDropRegistration>(
    () => ({ getClaim: () => claimRef.current, destinationKey, focusScopeKey }),
    [destinationKey, focusScopeKey]
  )
  // A guard transition ends the current hover before the next paint.
  useLayoutEffect(() => register?.(registration), [register, registration])
}

export function NativeChatPaneFileDropSurface({
  className,
  children
}: {
  className: string
  children: React.ReactNode
}): React.JSX.Element {
  const [registrations, setRegistrations] = useState<NativeChatPaneDropRegistration[]>([])
  const [activeScope, setActiveScope] = useState<string | null>(null)
  const registration =
    registrations.find((entry) => entry.focusScopeKey === activeScope) ??
    registrations.find((entry) => !entry.focusScopeKey?.startsWith('queued-edit:')) ??
    registrations[0] ??
    null
  const claimForTarget = useCallback(
    (target: EventTarget | null): NativeChatPaneDropClaim | null => {
      const scope =
        target instanceof Element
          ? target.closest<HTMLElement>('[data-native-chat-composer-scope]')?.dataset
              .nativeChatComposerScope
          : undefined
      return (
        (scope
          ? registrations.find((entry) => entry.focusScopeKey === scope)
          : registration
        )?.getClaim() ?? null
      )
    },
    [registration, registrations]
  )
  const [isDragActive, setIsDragActive] = useState(false)
  const ownerRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  const attachOwner = useOsFileDropOwner<CapturedNativeChatDrop | undefined>(ownerRef, {
    consumer: (destination) => destination?.preparationConsumer ?? 'agent',
    // A paired server's chat uploads the bytes; any other owner refuses with a notice.
    acceptsBrowserFiles: true,
    sequence,
    canAccept: (event) => {
      const claim = claimForTarget(event.target)
      return Boolean(claim && !claim.disabled)
    },
    captureDestination: (event) => claimForTarget(event.target)?.captureExternalDrop(),
    onDrop: async (prepared, { destination }) => {
      setIsDragActive(false)
      await deliverDroppedPaths(prepared, destination)
    }
  })
  const register = useMemo<RegisterPaneDropClaim>(
    () =>
      Object.assign(
        (next: NativeChatPaneDropRegistration) => {
          setRegistrations((current) => [...current, next])
          return () => {
            setRegistrations((current) => current.filter((entry) => entry !== next))
            setIsDragActive(false)
          }
        },
        { clearHover: () => setIsDragActive(false) }
      ),
    []
  )
  const handlers = useMemo(
    () =>
      makeNativeChatPaneFileDropHandlers({
        getClaim: (event) => claimForTarget(event.target ?? null),
        setDragActive: setIsDragActive,
        dropWebImage: (html, claim) => {
          dropWebImage(html, claim.captureExternalDrop()).catch((error: unknown) =>
            console.error('Web image drop failed', error)
          )
        }
      }),
    [claimForTarget]
  )
  // End hover even when the gesture finishes outside this pane.
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
        ref={attachOwner}
        {...handlers}
        onFocusCapture={(event) => {
          const field = event.target.closest<HTMLElement>('[data-native-chat-composer-scope]')
          if (field) {
            setActiveScope(field.dataset.nativeChatComposerScope ?? null)
          }
        }}
        onPointerDownCapture={(event) => {
          const field =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>('[data-native-chat-composer-scope]')
              : null
          if (field) {
            setActiveScope(field.dataset.nativeChatComposerScope ?? null)
          }
        }}
      >
        {children}
        {isDragActive ? <NativeChatPaneFileDropOverlay /> : null}
      </div>
    </NativeChatPaneFileDropContext.Provider>
  )
}

export function NativeChatPaneFileDropOverlay({
  queuedMessage = false
}: {
  queuedMessage?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      data-native-chat-drop-overlay="true"
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-chat-canvas/80"
    >
      <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-foreground/30 bg-card px-8 py-5 text-center shadow-floating">
        <span className="mb-1 flex size-9 items-center justify-center rounded-full bg-foreground/10">
          <Paperclip className="size-4.5" />
        </span>
        <span className="text-sm font-medium">
          {queuedMessage
            ? t('components.native-chat.drop.messageTitle', 'Drop to attach to this message')
            : t('components.native-chat.drop.title', 'Drop to attach to this chat')}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(
            'components.native-chat.drop.subtitle',
            'Files are added to your message as paths the agent can read.'
          )}
        </span>
      </div>
    </div>
  )
}
