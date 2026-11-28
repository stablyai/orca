import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getLocalImageCacheKey } from '@/components/editor/document-images/useLocalImageSrc'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  NativeChatMarkdownImageOwnerContext,
  nativeChatImageFileLinkContext,
  type NativeChatMarkdownImageOwner
} from '../native-chat-markdown-image-owner'
import {
  NATIVE_CHAT_GALLERY_ROOT_ATTRIBUTE,
  NativeChatGalleryCoveredFocusContext,
  NativeChatGalleryControllerContext,
  type NativeChatGalleryController,
  type NativeChatGalleryRecord
} from './native-chat-image-gallery-context'
import {
  captureNativeChatGallery,
  type NativeChatGalleryEntry
} from './native-chat-image-gallery-capture'
import { NativeChatImageGalleryDialog } from './NativeChatImageGalleryDialog'

const FENCE_ACCESS = chatImageAccess()

export type NativeChatGalleryCloseReason = 'user' | 'handoff' | 'hidden' | 'image' | 'chat'

type GallerySession = {
  entries: NativeChatGalleryEntry[]
  index: number
  announcement: string
  open: boolean
  opener: Element
  root: Element
  fence: string
  closedBy?: NativeChatGalleryCloseReason
}

/** Who may read the captured images: a new session, runtime or host must not keep showing them. */
function galleryFence(owner: NativeChatMarkdownImageOwner): string {
  return `${owner.sessionId ?? ''}\0${getLocalImageCacheKey('', null, owner.runtimeContext ?? undefined, FENCE_ACCESS)}`
}

function focusable(element: Element | null | undefined): HTMLElement | null {
  const target =
    element instanceof HTMLElement && element.tagName !== 'BUTTON'
      ? element.querySelector('button')
      : element
  return target instanceof HTMLElement && target.isConnected && !target.closest('[inert]')
    ? target
    : null
}

function stepAnnouncement(
  t: ReturnType<typeof useTranslate>,
  live: boolean[],
  index: number,
  title: string
): string {
  const position = live.slice(0, index + 1).filter(Boolean).length
  const count = live.filter(Boolean).length
  const step = t(
    'components.native-chat.imageGallery.stepAnnouncement',
    'Image {{position}} of {{count}} in this view: {{title}}.',
    { position, count, title }
  )
  const end =
    position === 1
      ? t('components.native-chat.imageGallery.firstImage', 'First image.')
      : position === count
        ? t('components.native-chat.imageGallery.lastImage', 'Last image.')
        : ''
  return end ? `${step} ${end}` : step
}

/** A subagent view over this list makes it inert without changing the tab's visibility. */
function shown(owner: NativeChatMarkdownImageOwner | null, root: Element | null): boolean {
  return owner?.isVisible !== false && root !== null && !root.closest('[inert]')
}

/** Steps a tab chat's settled images across messages; one message keeps its own viewer. The rows
 *  it wraps mark their root with `NATIVE_CHAT_GALLERY_ROOT_ATTRIBUTE`. */
export function NativeChatImageGallery({
  loadedMessageIds,
  children
}: {
  loadedMessageIds: ReadonlySet<string>
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const coveredFocus = useContext(NativeChatGalleryCoveredFocusContext)
  const fence = owner ? galleryFence(owner) : null
  const [records] = useState(() => new WeakMap<Element, NativeChatGalleryRecord>())
  const [session, setSession] = useState<GallerySession | null>(null)
  const latest = useRef({ fence, owner })
  const notice = useRef<string | number | undefined>(undefined)

  useLayoutEffect(() => {
    latest.current = { fence, owner }
  })

  const controller = useMemo<NativeChatGalleryController>(
    () => ({
      register: (element, record) => records.set(element, record),
      tryOpen: (element, block) => {
        const root = element.closest(`[${NATIVE_CHAT_GALLERY_ROOT_ATTRIBUTE}]`)
        const { fence: currentFence, owner: currentOwner } = latest.current
        if (!root || !shown(currentOwner, root) || currentFence === null) {
          return false
        }
        const capture = captureNativeChatGallery(root, records, element, block)
        if (!capture) {
          return false
        }
        toast.dismiss(notice.current)
        const active = document.activeElement
        setSession({
          ...capture,
          announcement: '',
          open: true,
          opener: active && element.contains(active) ? active : element,
          root,
          fence: currentFence
        })
        return true
      }
    }),
    [records]
  )

  const close = (closedBy: NativeChatGalleryCloseReason): void => {
    setSession((current) => (current?.open ? { ...current, open: false, closedBy } : current))
    if (closedBy === 'image' || closedBy === 'chat') {
      notice.current = toast(
        closedBy === 'image'
          ? t(
              'components.native-chat.imageGallery.closedImageChanged',
              'Preview closed because an image changed. Open a thumbnail to capture the current set.'
            )
          : t(
              'components.native-chat.imageGallery.closedChatChanged',
              'Preview closed because the chat changed. Open a thumbnail to capture the current set.'
            )
      )
    }
  }

  const selected = session?.open ? session.entries[session.index] : undefined
  useLayoutEffect(() => {
    if (!selected || !session) {
      return
    }
    if (!shown(owner, session.root)) {
      close('hidden')
    } else if (fence !== session.fence) {
      close('chat')
    } else if (!loadedMessageIds.has(selected.messageId)) {
      close('image')
    }
  })

  // Liveness reads only the list's own message ids, never producer records, so it is current here.
  const entries = session?.entries
  const live = useMemo(
    () => entries?.map((entry) => loadedMessageIds.has(entry.messageId)) ?? [],
    [entries, loadedMessageIds]
  )
  const previous = session && session.index > 0 ? live.lastIndexOf(true, session.index - 1) : -1
  const next = session ? live.indexOf(true, session.index + 1) : -1

  const restoreFocus = (current: GallerySession): void => {
    if (current.closedBy === 'handoff') {
      return
    }
    if (current.closedBy === 'hidden') {
      // The view that covered the list opened while focus was in here, so it could not take it then.
      const active = document.activeElement
      if (!active || active === document.body) {
        coveredFocus?.()?.focus({ preventScroll: true })
      }
      return
    }
    if (useAppStore.getState().activeModal !== 'none') {
      return
    }
    const openerAt = current.entries.findIndex(({ trigger }) => trigger.contains(current.opener))
    const nearest = current.entries
      .map((entry, at) => ({ entry, distance: Math.abs(at - Math.max(openerAt, 0)) }))
      .sort((a, b) => a.distance - b.distance)
    const target =
      focusable(current.opener) ??
      nearest.map(({ entry }) => focusable(entry.trigger)).find(Boolean)
    const scroller = current.root.closest<HTMLElement>('[tabindex]')
    ;(target ?? (scroller && !scroller.closest('[inert]') ? scroller : null))?.focus({
      preventScroll: true
    })
  }

  return (
    <NativeChatGalleryControllerContext value={controller}>
      {children}
      {session ? (
        <NativeChatImageGalleryDialog
          open={session.open}
          entry={session.entries[session.index]}
          position={live.slice(0, session.index + 1).filter(Boolean).length}
          count={live.filter(Boolean).length}
          announcement={session.announcement}
          fileLinkContext={nativeChatImageFileLinkContext(owner)}
          onStep={(direction) => {
            const to = direction === 'previous' ? previous : next
            if (to >= 0) {
              setSession({
                ...session,
                index: to,
                announcement: stepAnnouncement(t, live, to, session.entries[to].image.title)
              })
            }
          }}
          canStep={{ previous: previous >= 0, next: next >= 0 }}
          onClose={close}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus(session)
            setSession(null)
          }}
        />
      ) : null}
    </NativeChatGalleryControllerContext>
  )
}
