import React, { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'
import { prepareQuickOpenFiles, rankQuickOpenFiles } from '@/components/quick-open-search'
import { useRuntimeFileListForWorktree } from '@/components/quick-open-file-list'
import { useModalReturnFocus } from '@/hooks/useModalReturnFocus'
import { translate } from '@/i18n/i18n'
import {
  parseQuickOpenInstallRgGuidance,
  QuickOpenInstallRgGuidance
} from '@/components/quick-open-install-rg-guidance'

function FooterKey({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full border border-border/60 bg-muted/35 px-2 py-0.5 text-[10px] font-medium text-foreground/85">
      {children}
    </span>
  )
}

export default function QuickOpen(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'quick-open')
  const closeModal = useAppStore((s) => s.closeModal)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const openFile = useAppStore((s) => s.openFile)
  const activeWorktree = useActiveWorktree()

  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const { files, loading, loadError } = useRuntimeFileListForWorktree({
    enabled: visible,
    worktreeId: activeWorktreeId
  })

  const worktreePath = activeWorktree?.path ?? null

  // Why: Radix's onCloseAutoFocus restore is suppressed below, so dismissing
  // the dialog (Esc / click-away) would otherwise leave the active panel
  // unfocused. This returns focus to the surface that was active on open.
  const { captureReturnFocus, skipReturnFocus } = useModalReturnFocus(visible)

  // Why: reset input only on open. Keeping this out of the file-load effect
  // prevents unrelated store updates (which can produce a new excludePaths
  // array reference) from wiping a query the user is currently typing.
  const [previousVisible, setPreviousVisible] = useState(visible)
  if (visible !== previousVisible) {
    setPreviousVisible(visible)
    if (visible && query !== '') {
      setQuery('')
    }
  }

  const indexedFiles = useMemo(() => prepareQuickOpenFiles(files), [files])
  const filtered = useMemo(
    () => rankQuickOpenFiles(deferredQuery, indexedFiles),
    [deferredQuery, indexedFiles]
  )

  const handleSelect = useCallback(
    (relativePath: string) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      // Why: opening a file moves focus into the editor; don't restore focus to
      // the surface that was active before QuickOpen opened.
      skipReturnFocus()
      closeModal()
      openFile({
        filePath: joinPath(worktreePath, relativePath),
        relativePath,
        worktreeId: activeWorktreeId,
        language: detectLanguage(relativePath),
        mode: 'edit'
      })
    },
    [activeWorktreeId, worktreePath, openFile, closeModal, skipReturnFocus]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  const handleCloseAutoFocus = useCallback((e: Event) => {
    // Why: prevent Radix from stealing focus to the trigger element.
    e.preventDefault()
  }, [])

  const handleOpenAutoFocus = useCallback(() => {
    captureReturnFocus()
  }, [captureReturnFocus])

  return (
    <CommandDialog
      open={visible}
      onOpenChange={handleOpenChange}
      shouldFilter={false}
      onOpenAutoFocus={handleOpenAutoFocus}
      onCloseAutoFocus={handleCloseAutoFocus}
      title={translate('auto.components.QuickOpen.ec31e058f7', 'Go to file')}
      description={translate('auto.components.QuickOpen.9e97f08d0f', 'Search for a file to open')}
    >
      <CommandInput
        placeholder={translate('auto.components.QuickOpen.1cb6ef47b7', 'Go to file...')}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="p-2">
        {loading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {translate('auto.components.QuickOpen.722a21e1a8', 'Loading files...')}
          </div>
        ) : loadError ? (
          (() => {
            const guidance = parseQuickOpenInstallRgGuidance(loadError)
            return guidance ? (
              <QuickOpenInstallRgGuidance
                reason={guidance.reason}
                location={guidance.location}
                command={guidance.command}
                guidance={guidance.guidance}
              />
            ) : (
              <div className="py-6 px-4 text-center text-sm text-muted-foreground whitespace-pre-wrap">
                {loadError}
              </div>
            )
          })()
        ) : filtered.length === 0 ? (
          <CommandEmpty>
            {translate('auto.components.QuickOpen.74e2e1b3e4', 'No matching files.')}
          </CommandEmpty>
        ) : (
          filtered.map((item) => {
            const lastSlash = item.path.lastIndexOf('/')
            const dir = lastSlash >= 0 ? item.path.slice(0, lastSlash) : ''
            const filename = item.path.slice(lastSlash + 1)
            const FileIcon = getFileTypeIcon(item.path)

            return (
              <CommandItem
                key={item.path}
                value={item.path}
                onSelect={() => handleSelect(item.path)}
                className="flex items-center gap-2 px-3 py-1.5"
              >
                <FileIcon className="size-3.5 text-muted-foreground flex-shrink-0" />
                <span className="truncate text-foreground">{filename}</span>
                {dir && <span className="truncate text-muted-foreground ml-1">{dir}</span>}
              </CommandItem>
            )
          })
        )}
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <div className="flex items-center gap-2">
          <FooterKey>{translate('auto.components.QuickOpen.250e5b2dfb', 'Enter')}</FooterKey>
          <span>{translate('auto.components.QuickOpen.61b1c871a6', 'Open')}</span>
          <FooterKey>{translate('auto.components.QuickOpen.95fccbae88', 'Esc')}</FooterKey>
          <span>{translate('auto.components.QuickOpen.73b2c581f1', 'Close')}</span>
          <FooterKey>↑↓</FooterKey>
          <span>{translate('auto.components.QuickOpen.1dbd3f59ff', 'Move')}</span>
        </div>
      </div>
      {/* Accessibility: announce result count changes */}
      <div aria-live="polite" className="sr-only">
        {deferredQuery.trim()
          ? translate('auto.components.QuickOpen.b227d88520', '{{value0}} files found', {
              value0: filtered.length
            })
          : ''}
      </div>
    </CommandDialog>
  )
}
