import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { readWorkspaceFileDragPaths, WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { useAppStore } from '@/store'

export type ResolvedHtmlDropTarget = {
  url: string
  title: string
  sourceKind: 'workspace-file' | 'native-file' | 'uri-list' | 'text-selection'
}

export function isHtmlPathString(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') {
    return false
  }
  const clean = pathOrUrl.trim().split(/[?#]/)[0] ?? ''
  return /\.html?$/i.test(clean)
}

export function isHtmlOrWebUrlDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  if (!dataTransfer || !dataTransfer.types) {
    return false
  }
  const types = Array.from(dataTransfer.types)
  return (
    types.includes(WORKSPACE_FILE_PATH_MIME) ||
    types.includes('Files') ||
    types.includes('text/uri-list') ||
    types.includes('text/plain')
  )
}

function sanitizeDroppedPathText(raw: string): string {
  // Strip surrounding quotes and trailing sentence punctuation like commas or periods from terminal text
  return raw
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/[,;。，！!]+$/, '')
    .trim()
}

export function extractHtmlUrlFromDataTransfer(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'> & { files?: FileList },
  explicitWorktreePath?: string
): ResolvedHtmlDropTarget | null {
  // 1. Workspace internal file drag (e.g. from FileExplorer)
  if (dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
    const dragPaths = readWorkspaceFileDragPaths(dataTransfer, { maxPaths: 1 })
    if (dragPaths.status === 'accepted' && dragPaths.paths[0]) {
      const filePath = dragPaths.paths[0]
      if (isHtmlPathString(filePath)) {
        const title = filePath.split(/[/\\]/).pop() || filePath
        return {
          url: absolutePathToFileUri(filePath),
          title,
          sourceKind: 'workspace-file'
        }
      }
    }
  }

  // 2. Native OS files drag (from Finder or desktop)
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    const file = dataTransfer.files[0]
    const nativePath = (file as unknown as { path?: string })?.path
    if (nativePath && isHtmlPathString(nativePath)) {
      return {
        url: absolutePathToFileUri(nativePath),
        title: file.name || nativePath.split(/[/\\]/).pop() || 'HTML Preview',
        sourceKind: 'native-file'
      }
    }
    if (file && isHtmlPathString(file.name)) {
      // Browser File object without accessible filesystem path
      const objectUrl = URL.createObjectURL(file)
      return {
        url: objectUrl,
        title: file.name,
        sourceKind: 'native-file'
      }
    }
  }

  // 3. URI List (file:// or http(s)://)
  const uriList = dataTransfer.getData('text/uri-list')?.trim()
  if (uriList) {
    const firstUri = uriList.split(/[\r\n]+/)[0]?.trim() ?? ''
    if (
      firstUri.startsWith('file://') ||
      firstUri.startsWith('http://') ||
      firstUri.startsWith('https://')
    ) {
      const title = decodeURIComponent(firstUri.split('/').pop()?.split(/[?#]/)[0] || 'Web Preview')
      return {
        url: firstUri,
        title,
        sourceKind: 'uri-list'
      }
    }
  }

  // 4. Plain text (e.g. selected terminal text 'index.html' or '/path/to/index.html')
  const plainText = dataTransfer.getData('text/plain')
  if (plainText) {
    const candidate = sanitizeDroppedPathText(plainText)
    if (
      candidate.startsWith('http://') ||
      candidate.startsWith('https://') ||
      candidate.startsWith('file://')
    ) {
      const title = decodeURIComponent(candidate.split('/').pop()?.split(/[?#]/)[0] || candidate)
      return {
        url: candidate,
        title,
        sourceKind: 'text-selection'
      }
    }

    if (isHtmlPathString(candidate)) {
      // Determine worktree path
      let worktreePath = explicitWorktreePath
      if (!worktreePath) {
        try {
          const store = useAppStore.getState()
          const activeWorktreeId = store.activeWorktreeId
          if (activeWorktreeId && typeof store.allWorktrees === 'function') {
            const found = store.allWorktrees().find((w) => w.id === activeWorktreeId)
            if (found?.path) {
              worktreePath = found.path
            }
          }
        } catch {
          // Store might not be mounted in pure test contexts
        }
      }

      const isAbsolute = candidate.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(candidate)
      const resolvedPath = isAbsolute
        ? candidate
        : worktreePath
          ? `${worktreePath.replace(/[/\\]+$/, '')}/${candidate.replace(/^\.[/\\]/, '')}`
          : candidate

      const title = candidate.split(/[/\\]/).pop() || candidate
      return {
        url: absolutePathToFileUri(resolvedPath),
        title,
        sourceKind: 'text-selection'
      }
    }
  }

  return null
}
