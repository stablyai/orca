import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FilePlus, FileText, Globe, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useRuntimeFileListForWorktree } from '../quick-open-file-list'
import { classifyTabEntryQuery, type TabCreateEntryArgs } from './tab-create-entry-action'

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
  const inputRef = useRef<HTMLInputElement>(null)
  const fileList = useRuntimeFileListForWorktree({ enabled: menuOpen, worktreeId })

  useEffect(() => {
    if (!menuOpen) {
      setQuery('')
      setPending(false)
      setError(null)
      return
    }
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [menuOpen])

  const classification = useMemo(() => classifyTabEntryQuery(query, fileList), [fileList, query])

  const preview = useMemo(() => {
    if (!query.trim()) {
      return { icon: FilePlus, text: 'URL or file path' }
    }
    if (classification.kind === 'explicit-url' || classification.kind === 'host-url') {
      return { icon: Globe, text: classification.url }
    }
    if (classification.kind === 'existing-file') {
      return { icon: FileText, text: `Open ${classification.relativePath}` }
    }
    if (classification.kind === 'new-file') {
      return { icon: FilePlus, text: `Create ${classification.relativePath}` }
    }
    return { icon: fileList.loading ? Loader2 : FilePlus, text: classification.message }
  }, [classification, fileList.loading, query])

  const PreviewIcon = preview.icon
  const disabled = !onOpenEntry

  return (
    <form
      className="px-1 pb-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled || pending) {
          return
        }
        if (classification.kind === 'empty' || classification.kind === 'blocked') {
          setError(classification.message)
          return
        }
        setPending(true)
        setError(null)
        void onOpenEntry({ query, worktreeId, groupId, fileList })
          .then(() => {
            onDidOpenEntry?.()
          })
          .catch((caught) => {
            setError(caught instanceof Error ? caught.message : String(caught))
          })
          .finally(() => {
            setPending(false)
          })
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') {
          event.stopPropagation()
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setError(null)
        }}
        disabled={disabled}
        aria-label="Open URL or file"
        aria-invalid={error ? true : undefined}
        placeholder="URL or file path"
        className="h-8 rounded-[7px] px-2 text-[12px]"
      />
      <div className="mt-1 flex min-h-5 items-center gap-1.5 px-1 text-[11px] leading-5 text-muted-foreground">
        <PreviewIcon
          className={`size-3.5 shrink-0 ${preview.icon === Loader2 ? 'animate-spin' : ''}`}
          aria-hidden="true"
        />
        <span className="truncate">{error ?? preview.text}</span>
      </div>
    </form>
  )
}
