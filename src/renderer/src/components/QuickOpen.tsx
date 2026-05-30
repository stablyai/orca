/* oxlint-disable max-lines */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
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

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  useEffect(() => clearCopiedResetTimer, [clearCopiedResetTimer])

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
        <p className="text-[13px] leading-5">Quick Open scan too large ({reason}).</p>
      </div>
      <p>
        Install{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">ripgrep</code> on
        the remote to enable fast, gitignore-aware listing:
      </p>
      {command ? (
        <div className="flex items-center gap-2 rounded border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground">
          <span className="flex-1 truncate">{command}</span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Copy install command"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
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
      closeModal()
      openFile({
        filePath: joinPath(worktreePath, relativePath),
        relativePath,
        worktreeId: activeWorktreeId,
        language: detectLanguage(relativePath),
        mode: 'edit'
      })
    },
    [activeWorktreeId, worktreePath, openFile, closeModal]
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

  return (
    <CommandDialog
      open={visible}
      onOpenChange={handleOpenChange}
      shouldFilter={false}
      onCloseAutoFocus={handleCloseAutoFocus}
      title="Go to file"
      description="Search for a file to open"
    >
      <CommandInput placeholder="Go to file..." value={query} onValueChange={setQuery} />
      <CommandList className="p-2">
        {loading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Loading files...</div>
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
          <CommandEmpty>No matching files.</CommandEmpty>
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
          <FooterKey>Enter</FooterKey>
          <span>Open</span>
          <FooterKey>Esc</FooterKey>
          <span>Close</span>
          <FooterKey>↑↓</FooterKey>
          <span>Move</span>
        </div>
      </div>
      {/* Accessibility: announce result count changes */}
      <div aria-live="polite" className="sr-only">
        {deferredQuery.trim() ? `${filtered.length} files found` : ''}
      </div>
    </CommandDialog>
  )
}
