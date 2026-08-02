import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Editor } from '@tiptap/react'
import { getGitHubMarkdownImageUrlState } from './github-markdown-image-url'
import { translate } from '@/i18n/i18n'

export function useImageInput(
  editorRef: React.MutableRefObject<Editor | null>,
  disabledRef: React.MutableRefObject<boolean>,
  onOpen?: () => void
): {
  imageUrl: string
  imageInputOpen: boolean
  imageInputRef: React.RefObject<HTMLInputElement | null>
  openImagePicker: () => void
  setImageUrl: (value: string) => void
  setImageInputOpen: (open: boolean) => void
  insertImageUrl: () => void
} {
  const [imageInputOpen, setImageInputOpen] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const imageInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (imageInputOpen) {
      requestAnimationFrame(() => imageInputRef.current?.focus())
    }
  }, [imageInputOpen])

  const insertImageUrl = useCallback(() => {
    const editor = editorRef.current
    const imageUrlState = getGitHubMarkdownImageUrlState(imageUrl)
    if (!editor || imageUrlState.status === 'empty') {
      return
    }
    if (imageUrlState.status === 'too-large') {
      toast.error(
        translate(
          'auto.components.github.GitHubMarkdownComposer.imageUrlTooLarge',
          'Image URL is too large.'
        )
      )
      return
    }
    if (imageUrlState.status === 'invalid') {
      toast.error(
        translate(
          'auto.components.github.GitHubMarkdownComposer.ec6310b731',
          'Use an http:// or https:// image URL.'
        )
      )
      return
    }
    editor
      .chain()
      .focus()
      .insertContent({ type: 'image', attrs: { src: imageUrlState.url } })
      .run()
    setImageUrl('')
    setImageInputOpen(false)
  }, [imageUrl, editorRef])

  const openImagePicker = useCallback(() => {
    if (!disabledRef.current) {
      setImageInputOpen(true)
      onOpen?.()
    }
  }, [disabledRef, onOpen])

  return {
    imageUrl,
    imageInputOpen,
    imageInputRef,
    openImagePicker,
    setImageUrl,
    setImageInputOpen,
    insertImageUrl
  }
}
