import { Fragment, useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { useWorktreeById } from '@/store/selectors'
import type { OpenFile } from '@/store/slices/editor'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '../tab-bar/SortableTab'
import { EditorHeaderPathDirectoryMenu } from './EditorHeaderPathDirectoryMenu'
import {
  joinEditorHeaderPathEntry,
  listEditorHeaderDirectory,
  openEditorHeaderPathFile,
  type EditorHeaderDirectoryListing
} from './editor-header-path-directory'
import {
  getEditorHeaderPathPreviewSuffix,
  getEditorHeaderPathSegments,
  resolveEditorHeaderDirectoryAbsolutePath,
  type EditorHeaderPathSegment
} from './editor-header-path-segments'

type EditorHeaderPathBreadcrumbsProps = {
  activeFile: OpenFile
  pathTitle: string
}

type ListingState = {
  segmentId: string
  directoryAbsolutePath: string
  directoryRelativePath: string
}

export function EditorHeaderPathBreadcrumbs({
  activeFile,
  pathTitle
}: EditorHeaderPathBreadcrumbsProps): React.JSX.Element {
  const worktree = useWorktreeById(activeFile.worktreeId)
  const worktreePath = worktree?.path ?? null
  const openFile = useAppStore((state) => state.openFile)
  const openMarkdownPreview = useAppStore((state) => state.openMarkdownPreview)
  const activeGroupId = useAppStore((state) => state.activeGroupIdByWorktree[activeFile.worktreeId])
  const { worktreeId, runtimeEnvironmentId, externalSshTargetId, operationProvenance } = activeFile
  const segments = getEditorHeaderPathSegments(activeFile) ?? []
  const previewSuffix = getEditorHeaderPathPreviewSuffix(activeFile)
  const [listing, setListing] = useState<ListingState | null>(null)
  const [loadState, setLoadState] = useState<EditorHeaderDirectoryListing | { status: 'loading' }>({
    status: 'loading'
  })

  useEffect(() => {
    const closeListing = (): void => setListing(null)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeListing)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeListing)
  }, [])

  useEffect(() => {
    if (!listing) {
      return
    }
    let cancelled = false
    setLoadState({ status: 'loading' })
    void listEditorHeaderDirectory(
      { worktreeId, runtimeEnvironmentId, externalSshTargetId, operationProvenance },
      worktreePath,
      listing.directoryAbsolutePath
    ).then((result) => {
      if (!cancelled) {
        setLoadState(result)
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    externalSshTargetId,
    listing,
    operationProvenance,
    runtimeEnvironmentId,
    worktreeId,
    worktreePath
  ])

  const openListing = (segment: EditorHeaderPathSegment): void => {
    setLoadState({ status: 'loading' })
    setListing({
      segmentId: segment.id,
      directoryRelativePath: segment.relativeDirectoryPath,
      directoryAbsolutePath: resolveEditorHeaderDirectoryAbsolutePath(
        activeFile,
        worktreePath,
        segment.relativeDirectoryPath
      )
    })
  }

  const handleSelectEntry = (entry: DirEntry): void => {
    if (!listing) {
      return
    }
    if (entry.isDirectory) {
      setLoadState({ status: 'loading' })
      setListing({
        ...listing,
        directoryRelativePath: listing.directoryRelativePath
          ? `${listing.directoryRelativePath}/${entry.name}`
          : entry.name,
        directoryAbsolutePath: joinPath(listing.directoryAbsolutePath, entry.name)
      })
      return
    }
    openEditorHeaderPathFile({
      currentFile: activeFile,
      ...joinEditorHeaderPathEntry(
        listing.directoryAbsolutePath,
        listing.directoryRelativePath,
        entry.name
      ),
      targetGroupId: activeGroupId ?? undefined,
      openFile,
      openMarkdownPreview
    })
    setListing(null)
  }

  return (
    <div className="editor-header-path editor-header-path--breadcrumbs" title={pathTitle}>
      {segments.map((segment, index) => (
        <Fragment key={segment.id}>
          {index > 0 ? <span className="editor-header-path-separator">/</span> : null}
          <Popover
            open={listing?.segmentId === segment.id}
            onOpenChange={(open) => {
              if (open) {
                openListing(segment)
                return
              }
              if (!open && listing?.segmentId === segment.id) {
                setListing(null)
              }
            }}
            modal={false}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                data-editor-header-path-segment={segment.id}
                className={`editor-header-path-segment${
                  segment.isFile ? ' editor-header-path-segment-current' : ''
                }`}
                aria-label={translate(
                  'auto.components.editor.EditorPanelHeaderPath.5d0a8b17c3',
                  'Browse {{value0}}',
                  { value0: segment.label }
                )}
              >
                {segment.label}
              </button>
            </PopoverTrigger>
            {listing?.segmentId === segment.id ? (
              <PopoverContent align="start" side="bottom" sideOffset={4} className="w-auto p-0">
                <EditorHeaderPathDirectoryMenu
                  loadState={loadState}
                  directoryAbsolutePath={listing.directoryAbsolutePath}
                  currentFilePath={activeFile.filePath}
                  onSelectEntry={handleSelectEntry}
                />
              </PopoverContent>
            ) : null}
          </Popover>
        </Fragment>
      ))}
      {previewSuffix ? (
        <span className="editor-header-path-preview-suffix">{previewSuffix}</span>
      ) : null}
    </div>
  )
}
