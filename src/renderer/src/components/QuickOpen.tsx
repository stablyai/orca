/* oxlint-disable max-lines */
import React, { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy } from 'lucide-react'
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

/**
 * Parses the install-ripgrep guidance message produced by the relay's
 * buildInstallRgMessage(). Returns the parts needed to render as formatted
 * guidance (reason + install command) when matched, or null otherwise so
 * callers can fall back to plain-text display.
 *
 * Why: the message is plain text on the wire (thrown as an Error), but the
 * renderer is the only place with enough UI vocabulary to present ripgrep
 * as an inline code span and the install command as a copyable code block.
 */
function parseInstallRgGuidance(
  message: string
): { reason: string; command: string | null; guidance: string | null } | null {
  const match = message.match(
    /^Quick Open scan too large \(([^)]+)\)\. Install ripgrep on the remote to enable fast, gitignore-aware listing: (.+)$/
  )
  if (!match) {
    return null
  }
  const reason = match[1]
  const tail = match[2].trim()
  // Why: on unknown distros the relay emits prose like "install ripgrep via
  // your package manager (e.g. apt/dnf/pacman)" — there's no single command
  // to copy, so surface it as plain guidance without the code block.
  const looksLikeCommand = /^(sudo\s+)?(brew|apt|dnf|pacman|apk)\s/.test(tail)
  return {
    reason,
    command: looksLikeCommand ? tail : null,
    guidance: looksLikeCommand ? null : tail
  }
}

function FooterKey({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full border border-border/60 bg-muted/35 px-2 py-0.5 text-[10px] font-medium text-foreground/85">
      {children}
    </span>
  )
}

function InstallRgGuidance({
  reason,
  command,
  guidance
}: {
  reason: string
  command: string | null
  guidance?: string | null
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after this guidance unmounts; avoid
  // starting a reset timer that will outlive the component.
  const isMountedRef = useRef(false)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  const setCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )

  const handleCopy = useCallback(() => {
    if (!command) {
      return
    }
    // Why: use Electron's clipboard IPC instead of navigator.clipboard — the
    // latter often fails silently in the renderer due to focus/permission
    // quirks inside Radix dialogs. All other copy buttons in the app go
    // through window.api.ui.writeClipboardText for consistency.
    void window.api.ui
      .writeClipboardText(command)
      .then(() => {
        if (!isMountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        /* best-effort */
      })
  }, [clearCopiedResetTimer, command])

  return (
    <div className="px-4 py-5 text-sm text-muted-foreground space-y-3">
      <div
        role="alert"
        className="flex items-start gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p className="text-[13px] leading-5">
          {translate('auto.components.QuickOpen.4725b0e931', 'Quick Open scan too large (')}
          {reason}).
        </p>
      </div>
      <p>
        {translate('auto.components.QuickOpen.2ca749c15d', 'Install')}{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
          {translate('auto.components.QuickOpen.5d80dc39bb', 'ripgrep')}
        </code>{' '}
        {translate(
          'auto.components.QuickOpen.1cf8561ab4',
          'on the remote to enable fast, gitignore-aware listing:'
        )}
      </p>
      {command ? (
        <div className="flex items-center gap-2 rounded border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground">
          <span className="flex-1 truncate">{command}</span>
          <button
            ref={setCopyButtonRef}
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label={translate('auto.components.QuickOpen.73b44e7bde', 'Copy install command')}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied
              ? translate('auto.components.QuickOpen.cf144856dc', 'Copied')
              : translate('auto.components.QuickOpen.995be8ea22', 'Copy')}
          </button>
        </div>
      ) : guidance ? (
        <p className="text-[13px] leading-5 text-foreground">{guidance}</p>
      ) : null}
    </div>
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
            const guidance = parseInstallRgGuidance(loadError)
            return guidance ? (
              <InstallRgGuidance
                reason={guidance.reason}
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
