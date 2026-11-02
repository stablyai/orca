import type { Editor } from '@tiptap/react'
import type { Slice } from '@tiptap/pm/model'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { blobToBase64, convertImageBlobToPng } from '@/lib/image-blob-png'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-import-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { assertClipboardImageBase64LengthWithinLimit } from '../../../../shared/clipboard-image'
import { getRichMarkdownImageResolverContextVersion } from './rich-markdown-image-context'
import {
  captureRichMarkdownImageImportDestination,
  encodeMarkdownImageBasename,
  type RichMarkdownImageImportDestination
} from './rich-markdown-image-insert'

type BlobImagePasteArgs = {
  editor: Editor | null
  slice: Slice | undefined
  filePath: string
  worktreeId: string | null
  runtimeEnvironmentId?: string | null
}

/** Only object URLs minted by this renderer can be read back; foreign ones are left as pasted. */
function collectOwnBlobImageSources(slice: Slice): string[] {
  const prefix = `blob:${window.location.origin}/`
  const sources = new Set<string>()
  slice.content.descendants((node) => {
    const src: unknown = node.attrs.src
    if (node.type.name === 'image' && typeof src === 'string' && src.startsWith(prefix)) {
      sources.add(src)
    }
  })
  return [...sources]
}

/**
 * Lets the paste insert natively, then saves images that point at this renderer's blob: URLs
 * beside the note and swaps their src, since object URLs die with their source or on restart.
 * Any image that fails keeps its pasted src; the pasted content itself is never withheld.
 */
export function scheduleRichMarkdownBlobImageImport({
  editor,
  slice,
  filePath,
  worktreeId,
  runtimeEnvironmentId
}: BlobImagePasteArgs): void {
  if (!editor || !slice || editor.isDestroyed) {
    return
  }
  const sources = collectOwnBlobImageSources(slice)
  if (sources.length === 0) {
    return
  }
  const view = editor.view
  const contextVersion = getRichMarkdownImageResolverContextVersion(editor)
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  editor.on('destroy', abort)
  const isTargetCurrent = (): boolean =>
    !controller.signal.aborted &&
    !editor.isDestroyed &&
    editor.isEditable &&
    editor.view === view &&
    getRichMarkdownImageResolverContextVersion(editor) === contextVersion
  // Why: fetch now, before the source surface can revoke its object URLs.
  const reads = sources.map((src) => fetch(src, { signal: controller.signal }))
  reads.forEach((read) => read.catch(() => {}))

  void (async () => {
    let failed = false
    let destination: RichMarkdownImageImportDestination | null | undefined
    for (const [index, src] of sources.entries()) {
      try {
        const response = await reads[index]
        if (!response.ok) {
          throw new Error(`Failed to read ${src}`)
        }
        const png = await convertImageBlobToPng(await response.blob())
        const contentBase64 = await blobToBase64(png)
        assertClipboardImageBase64LengthWithinLimit(contentBase64.length)
        // Skip the write when the paste was transformed (e.g. to plain text) or the image was removed.
        if (!isTargetCurrent() || findImagePositions(editor, src).length === 0) {
          continue
        }
        destination ??= captureRichMarkdownImageImportDestination({
          filePath,
          worktreeId,
          runtimeEnvironmentId
        })
        if (!destination) {
          return
        }
        destination.assertCurrent?.()
        // Why: the temp file is local, as for OS clipboard images; the import uploads it to SSH/runtime owners.
        const tempPath = await callRuntimeRpc<string>(
          { kind: 'local' },
          'clipboard.saveImageAsTempFile',
          { contentBase64 },
          { signal: controller.signal }
        )
        destination.assertCurrent?.()
        const { results } = await importExternalPathsToRuntime(
          destination.context,
          [tempPath],
          destination.destinationDir,
          {
            access: destination.access,
            ...(destination.assertCurrent ? { assertCurrent: destination.assertCurrent } : {})
          }
        )
        destination.assertCurrent?.()
        const imported = results.find((result) => result.status === 'imported')
        if (!imported) {
          throw new Error(`Failed to import ${src}`)
        }
        if (isTargetCurrent()) {
          replaceImageSource(editor, src, encodeMarkdownImageBasename(imported.destPath))
        }
      } catch {
        if (controller.signal.aborted) {
          return
        }
        failed = true
      }
    }
    if (failed && isTargetCurrent()) {
      toast.error(
        translate(
          'auto.components.editor.richMarkdownBlobImagePaste.saveFailed',
          "Couldn't save a pasted image beside the document. It may not load after Orca restarts."
        )
      )
    }
  })()
    .catch(() => {})
    .finally(() => editor.off('destroy', abort))
}

function findImagePositions(editor: Editor, src: string): number[] {
  const positions: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === src) {
      positions.push(pos)
    }
  })
  return positions
}

function replaceImageSource(editor: Editor, src: string, nextSrc: string): void {
  const positions = findImagePositions(editor, src)
  if (positions.length === 0) {
    return
  }
  const tr = editor.state.tr
  for (const pos of positions) {
    tr.setNodeAttribute(pos, 'src', nextSrc)
  }
  // Why: undoing the paste should remove it in one step, not first restore the dead blob: src.
  editor.view.dispatch(tr.setMeta('addToHistory', false))
}
