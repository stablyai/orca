import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FilePlus, FileText, Globe, Loader2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useRuntimeFileListForWorktree } from '../quick-open-file-list'
import {
  getTabEntryOptions,
  type TabCreateEntryArgs,
  type TabEntryActionClassification,
  type TabEntryOption
} from './tab-create-entry-action'

type TabBarCreateEntryProps = {
  groupId: string
  menuOpen: boolean
  onDidOpenEntry?: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  worktreeId: string
}

export default function TabBarCreateEntry({
  groupId,
  menuOpen,
  onDidOpenEntry,
  onOpenEntry,
  worktreeId
}: TabBarCreateEntryProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileList = useRuntimeFileListForWorktree({ enabled: menuOpen, worktreeId })

  useEffect(() => {
    if (!menuOpen) {
      setQuery('')
      setPending(false)
      setError(null)
      setSelectedIndex(0)
      return
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [menuOpen])

  const options = useMemo(() => getTabEntryOptions(query, fileList), [fileList, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const disabled = !onOpenEntry
  const hasQuery = query.trim().length > 0
  const activeOptions = options.filter(isActiveEntryOption)
  const activeSelectedIndex = Math.min(selectedIndex, Math.max(activeOptions.length - 1, 0))
  const selectedActiveOption = activeOptions[activeSelectedIndex]
  const statusOption = options.find(
    (option) => option.classification.kind === 'empty' || option.classification.kind === 'blocked'
  )
  const statusMessage =
    statusOption?.classification.kind === 'empty' || statusOption?.classification.kind === 'blocked'
      ? statusOption.classification.message
      : 'URL, file, or new file'

  const submitOption = (classification?: TabEntryActionClassification) => {
    if (disabled || pending) {
      return
    }
    const selectedClassification = classification ?? selectedActiveOption?.classification ?? null
    if (!selectedClassification) {
      setError(statusMessage)
      return
    }
    setPending(true)
    setError(null)
    void onOpenEntry({
      query,
      worktreeId,
      groupId,
      fileList,
      classification: selectedClassification
    })
      .then(() => {
        onDidOpenEntry?.()
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        setPending(false)
      })
  }

  return (
    <form
      className="px-1 pb-1"
      onSubmit={(event) => {
        event.preventDefault()
        submitOption()
      }}
      onKeyDown={(event) => {
        if (activeOptions.length > 1 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          event.stopPropagation()
          setSelectedIndex((current) => {
            const delta = event.key === 'ArrowDown' ? 1 : -1
            return (current + delta + activeOptions.length) % activeOptions.length
          })
          return
        }
        if (event.key !== 'Escape') {
          event.stopPropagation()
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setError(null)
          }}
          disabled={disabled}
          aria-label="Open URL, file, or new file"
          aria-invalid={error ? true : undefined}
          placeholder="URL, file, or new file"
          className="h-8 rounded-[7px] pl-7 pr-2 text-[12px]"
        />
      </div>
      {error || activeOptions.length > 0 || hasQuery ? (
        <div className="mt-1 space-y-0.5">
          {error ? (
            <EntryStatusRow message={error} />
          ) : activeOptions.length > 0 ? (
            activeOptions.map((option, index) => (
              <EntryActionRow
                key={option.id}
                classification={option.classification}
                selected={index === activeSelectedIndex}
                onClick={() => submitOption(option.classification)}
              />
            ))
          ) : (
            <EntryStatusRow loading={fileList.loading} message={statusMessage} />
          )}
        </div>
      ) : null}
    </form>
  )
}

type ActiveEntryOption = TabEntryOption & {
  classification: TabEntryActionClassification
}

function isActiveEntryOption(option: TabEntryOption): option is ActiveEntryOption {
  return option.classification.kind !== 'empty' && option.classification.kind !== 'blocked'
}

function EntryStatusRow({
  loading = false,
  message
}: {
  loading?: boolean
  message: string
}): React.JSX.Element {
  return (
    <div className="flex min-h-6 items-center gap-1.5 rounded-[7px] px-1 text-[11px] leading-5 text-muted-foreground">
      {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
      <span className="truncate">{message}</span>
    </div>
  )
}

function EntryActionRow({
  classification,
  onClick,
  selected
}: {
  classification: TabEntryActionClassification
  onClick: () => void
  selected: boolean
}): React.JSX.Element {
  const { detail, icon: Icon, label } = getActionPresentation(classification)

  return (
    <button
      type="button"
      className={cn(
        'flex h-6 w-full items-center gap-1.5 rounded-[7px] px-1 text-left text-[11px] leading-5 outline-none',
        selected
          ? 'bg-black/8 text-accent-foreground dark:bg-white/14'
          : 'text-muted-foreground hover:bg-black/8 hover:text-accent-foreground dark:hover:bg-white/14'
      )}
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="text-muted-foreground/70" aria-hidden="true">
        ·
      </span>
      <span className="min-w-0 truncate">{detail}</span>
    </button>
  )
}

function getActionPresentation(classification: TabEntryActionClassification): {
  detail: string
  icon: typeof FilePlus
  label: string
} {
  if (classification.kind === 'explicit-url' || classification.kind === 'host-url') {
    return { detail: classification.url, icon: Globe, label: 'Open URL' }
  }
  if (classification.kind === 'existing-file') {
    return { detail: classification.relativePath, icon: FileText, label: 'Open file' }
  }
  return { detail: classification.relativePath, icon: FilePlus, label: 'Create file' }
}
