import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FilePlus, FileText, Globe, Loader2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { useRuntimeFileListForWorktree } from '../quick-open-file-list'
import {
  getTabEntryOptions,
  type TabCreateEntryArgs,
  type TabEntryActionClassification,
  type TabEntryOption
} from './tab-create-entry-action'
import {
  findMatchingTabAgentLaunchOptions,
  type TabAgentLaunchOption
} from './tab-agent-launch-options'
import type { TuiAgent } from '../../../../shared/types'

type TabBarCreateEntryProps = {
  agentOptions?: readonly TabAgentLaunchOption[]
  groupId: string
  menuOpen: boolean
  onDidOpenEntry?: () => void
  onLaunchAgent?: (agent: TuiAgent) => void
  onOpenDefaultTerminal?: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  worktreeId: string
}

export default function TabBarCreateEntry({
  agentOptions = [],
  groupId,
  menuOpen,
  onDidOpenEntry,
  onLaunchAgent,
  onOpenDefaultTerminal,
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
  const matchingAgentOptions = useMemo(
    () => findMatchingTabAgentLaunchOptions(query, agentOptions),
    [agentOptions, query]
  )

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const disabled = !onOpenEntry
  const hasQuery = query.trim().length > 0
  const activeOptions: ActiveOption[] = [
    ...matchingAgentOptions.map((option) => ({
      kind: 'agent' as const,
      option
    })),
    ...options.filter(isActiveEntryOption).map((option) => ({
      kind: 'entry' as const,
      option
    }))
  ]
  const activeSelectedIndex = Math.min(selectedIndex, Math.max(activeOptions.length - 1, 0))
  const selectedActiveOption = activeOptions[activeSelectedIndex]
  const statusOption = options.find(
    (option) => option.classification.kind === 'empty' || option.classification.kind === 'blocked'
  )
  const statusMessage =
    statusOption?.classification.kind === 'empty' || statusOption?.classification.kind === 'blocked'
      ? statusOption.classification.message
      : 'URL, file, or new file'

  const submitOption = (option?: ActiveOption) => {
    if (disabled || pending) {
      return
    }
    const selectedOption = option ?? selectedActiveOption ?? null
    if (!selectedOption) {
      if (!hasQuery && onOpenDefaultTerminal) {
        onOpenDefaultTerminal()
        onDidOpenEntry?.()
        return
      }
      setError(statusMessage)
      return
    }
    if (selectedOption.kind === 'agent') {
      onLaunchAgent?.(selectedOption.option.agent)
      onDidOpenEntry?.()
      return
    }
    setPending(true)
    setError(null)
    void onOpenEntry({
      query,
      worktreeId,
      groupId,
      fileList,
      classification: selectedOption.option.classification
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
                key={getActiveOptionId(option)}
                option={option}
                selected={index === activeSelectedIndex}
                onClick={() => submitOption(option)}
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

type ActiveOption =
  | {
      kind: 'agent'
      option: TabAgentLaunchOption
    }
  | {
      kind: 'entry'
      option: ActiveEntryOption
    }

function isActiveEntryOption(option: TabEntryOption): option is ActiveEntryOption {
  return option.classification.kind !== 'empty' && option.classification.kind !== 'blocked'
}

function getActiveOptionId(option: ActiveOption): string {
  return option.kind === 'agent' ? `agent:${option.option.agent}` : option.option.id
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
  onClick,
  option,
  selected
}: {
  onClick: () => void
  option: ActiveOption
  selected: boolean
}): React.JSX.Element {
  const presentation = getActionPresentation(option)

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
      {presentation.icon}
      <span className="shrink-0 font-medium">{presentation.label}</span>
      <span className="text-muted-foreground/70" aria-hidden="true">
        ·
      </span>
      <span className="min-w-0 truncate">{presentation.detail}</span>
    </button>
  )
}

function getActionPresentation(option: ActiveOption): {
  detail: string
  icon: React.ReactNode
  label: string
} {
  if (option.kind === 'agent') {
    return {
      detail: option.option.label,
      icon: <AgentIcon agent={option.option.agent} size={14} />,
      label: 'Launch agent'
    }
  }
  const { classification } = option.option
  if (classification.kind === 'explicit-url' || classification.kind === 'host-url') {
    return {
      detail: classification.url,
      icon: <Globe className="size-3.5 shrink-0" aria-hidden="true" />,
      label: 'Open URL'
    }
  }
  if (classification.kind === 'existing-file') {
    return {
      detail: classification.relativePath,
      icon: <FileText className="size-3.5 shrink-0" aria-hidden="true" />,
      label: 'Open file'
    }
  }
  return {
    detail: classification.relativePath,
    icon: <FilePlus className="size-3.5 shrink-0" aria-hidden="true" />,
    label: 'Create file'
  }
}
