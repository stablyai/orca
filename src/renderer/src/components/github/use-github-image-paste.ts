import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { Node as TiptapNode } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import { translate } from '@/i18n/i18n'
import type { GitHubImageUploadAddress } from './github-image-upload'
import { useGitHubImageEvents, useGitHubImageUploads } from './use-github-image-uploads'

export function useGitHubImagePaste(
  root: RefObject<HTMLDivElement | null>,
  editor: RefObject<Editor | null>,
  address: GitHubImageUploadAddress | (() => GitHubImageUploadAddress) | undefined,
  onPending: ((pending: boolean) => void) | undefined,
  enabled: boolean
) {
  const options = useRef({ address, onPending, enabled })
  const uploads = useGitHubImageUploads({ address, onPending, enabled })
  const live = useRef(new Set<string>())
  useLayoutEffect(() => {
    options.current = { address, onPending, enabled }
  })
  useLayoutEffect(
    () => () => {
      live.current.clear()
    },
    []
  )
  const extension = useMemo(
    () =>
      TiptapNode.create({
        name: 'githubImageUpload',
        inline: true,
        group: 'inline',
        atom: true,
        addAttributes: () => ({ id: { default: null }, name: { default: '' } }),
        renderHTML: ({ node }) => ['span', {}, `Uploading ${node.attrs.name}…`],
        renderMarkdown: () => '',
        addNodeView:
          () =>
          ({ node }) => {
            const dom = document.createElement('span')
            dom.className = 'text-muted-foreground'
            dom.textContent = live.current.has(node.attrs.id) ? `Uploading ${node.attrs.name}…` : ''
            return { dom }
          }
      }),
    []
  )

  const receive = (files: File[], at?: number): boolean => {
    const current = editor.current
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length || !options.current.enabled || !current || current.isDestroyed) {
      return false
    }
    if (at !== undefined) {
      current.commands.setTextSelection(at)
    }
    return uploads.receive(images, (file) => {
      const id = createBrowserUuid()
      live.current.add(id)
      current.commands.insertContent({
        type: 'githubImageUpload',
        attrs: { id, name: file.name || 'image.png' }
      })
      return (url?: string) => {
        live.current.delete(id)
        if (current.isDestroyed) {
          return
        }
        let position: number | undefined
        current.state.doc.descendants((node, pos) => {
          if (node.type.name === 'githubImageUpload' && node.attrs.id === id) {
            position = pos
          }
        })
        if (position === undefined) {
          return
        }
        const tr = current.state.tr
        if (url) {
          tr.replaceWith(
            position,
            position + 1,
            current.schema.nodes.image.create({ src: url, alt: file.name })
          )
        } else {
          tr.delete(position, position + 1)
        }
        current.view.dispatch(tr.setMeta('addToHistory', false))
      }
    })
  }

  const events = useGitHubImageEvents<number | undefined>(
    root,
    receive,
    (event) => editor.current?.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos,
    (event) =>
      !!(
        options.current.enabled &&
        editor.current?.isEditable &&
        event.target instanceof globalThis.Node &&
        editor.current.view.dom.contains(event.target)
      )
  )
  return {
    extension,
    pending: uploads.pending,
    attachDrop: events.attachDrop,
    handlePaste: (_view: unknown, event: ClipboardEvent) => events.paste(event),
    transformPastedHTML: (html: string) => {
      if (!/\bsrc\s*=\s*["']?data:/i.test(html)) {
        return html
      }
      const document = new DOMParser().parseFromString(html, 'text/html')
      const images = document.querySelectorAll('img[src^="data:" i]')
      if (images.length) {
        images.forEach((image) => image.remove())
        toast.error(
          translate('github.pasteImageFile', 'Paste the image as a file to attach it to GitHub.')
        )
      }
      return document.body.innerHTML
    }
  }
}
