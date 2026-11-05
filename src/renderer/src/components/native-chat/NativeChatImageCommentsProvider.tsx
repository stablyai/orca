import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { Image as ImageIcon, MessageSquarePlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import {
  captureNativeChatImage,
  copyNativeChatImage,
  type NativeChatCopyImage
} from './native-chat-image-copy'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { NativeChatImageCommentsDialog } from './NativeChatImageCommentsDialog'

type OpenImageComments = (image: NativeChatCopyImage, title: string) => void
export const NativeChatImageCommentsContext = createContext<OpenImageComments | null>(null)

export function NativeChatImageMenuItems({
  image,
  onSelected
}: {
  image?: NativeChatCopyImage
  onSelected: () => void
}): React.JSX.Element | null {
  const open = useContext(NativeChatImageCommentsContext)
  if (!image) {
    return null
  }
  return (
    <>
      <DropdownMenuItem onSelect={() => void copyNativeChatImage(image)}>
        <ImageIcon />
        {translate('components.native-chat.composer.copyImage', 'Copy image')}
      </DropdownMenuItem>
      {open ? (
        <DropdownMenuItem
          onSelect={() => {
            onSelected()
            open(image, translate('components.native-chat.transcript.imageFallback', 'Image'))
          }}
        >
          <MessageSquarePlus />
          {translate('components.native-chat.imageComments.action', 'Comment on image')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

export function NativeChatImageCommentsProvider({
  composerRef,
  children,
  ...rootProps
}: React.ComponentProps<'div'> & {
  composerRef: RefObject<NativeChatComposerHandle | null>
  children: ReactNode
}): React.JSX.Element {
  const [request, setRequest] = useState<{
    image: NativeChatCopyImage
    title: string
    destination: NativeChatComposerHandle
  } | null>(null)
  const open = useCallback<OpenImageComments>(
    (image, title) => {
      const destination = composerRef.current
      if (!destination?.attachCommentedImage || !destination.acceptsText()) {
        toast.error(
          translate(
            'components.native-chat.imageComments.draftUnavailable',
            'The chat draft is unavailable. Try again when the input is ready.'
          )
        )
        return
      }
      setRequest({ image, title, destination })
    },
    [composerRef]
  )
  return (
    <NativeChatImageCommentsContext.Provider value={open}>
      <div {...rootProps}>{children}</div>
      {request ? (
        <NativeChatImageCommentsDialog
          image={request.image}
          title={request.title}
          onClose={() => setRequest(null)}
          onDone={async (dataUrl, text) => {
            const attached = await request.destination.attachCommentedImage?.(dataUrl, text)
            if (!attached) {
              throw new Error(
                translate(
                  'components.native-chat.imageComments.attachFailed',
                  'The image could not be added to this chat draft. Your comments are still here; try again.'
                )
              )
            }
            setRequest(null)
            requestAnimationFrame(() => request.destination.focus())
          }}
        />
      ) : null}
    </NativeChatImageCommentsContext.Provider>
  )
}

export function NativeChatImageCommentButton({
  src,
  title,
  onStart
}: {
  src: string | null | undefined
  title: string
  onStart: () => void
}): React.JSX.Element | null {
  const open = useContext(NativeChatImageCommentsContext)
  if (!open || !src) {
    return null
  }
  const label = translate('components.native-chat.imageComments.action', 'Comment on image')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={() => {
            const image = captureNativeChatImage(src)
            onStart()
            open(image, title)
          }}
        >
          <MessageSquarePlus />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
