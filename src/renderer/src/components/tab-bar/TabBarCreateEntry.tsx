import React, { useEffect, useMemo, useRef, useState } from 'react'
import { FilePlus, FileText, Globe, Loader2, Smartphone, TerminalSquare } from 'lucide-react'
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
import {
  findMatchingTabCreateMenuOptions,
  type TabCreateMenuOption
} from './tab-create-menu-options'
import type { TuiAgent } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

const EMPTY_AGENT_OPTIONS: readonly TabAgentLaunchOption[] = []
const EMPTY_MENU_OPTIONS: readonly TabCreateMenuOption[] = []

type TabBarCreateEntryProps = {
  agentOptions?: readonly TabAgentLaunchOption[]
  groupId: string
  menuOpen: boolean
  menuOptions?: readonly TabCreateMenuOption[]
  onDidOpenEntry?: () => void
  onLaunchAgent?: (agent: TuiAgent) => void
  onOpenDefaultTerminal?: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  onQueryChange?: (query: string) => void
  onSelectMenuOption?: (option: TabCreateMenuOption) => void
  worktreeId: string
}

export default function TabBarCreateEntry({
  agentOptions = EMPTY_AGENT_OPTIONS,
  groupId,
  menuOpen,
  menuOptions = EMPTY_MENU_OPTIONS,
  onDidOpenEntry,
  onLaunchAgent,
  onOpenDefaultTerminal,
  onOpenEntry,
  onQueryChange,
  onSelectMenuOption,
  worktreeId
}: TabBarCreateEntryProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedIndexQuery, setSelectedIndexQuery] = useState(query)
  const [lastMenuOpen, setLastMenuOpen] = useState(menuOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileList = useRuntimeFileListForWorktree({ enabled: menuOpen, worktreeId })

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const focusFrame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(focusFrame)
  }, [menuOpen])

  const matchingMenuOptions = useMemo(
    () => findMatchingTabCreateMenuOptions(query, menuOptions),
    [menuOptions, query]
  )
  const options = useMemo(() => {
    const entryOptions = getTabEntryOptions(query, fileList)
    if (matchingMenuOptions.length === 0) {
      return entryOptions
    }
    // Why: a matched create-menu action should win over a generic new-file fallback.
    return entryOptions.filter((option) => option.classification.kind !== 'new-file')
  }, [fileList, matchingMenuOptions.length, query])
  const matchingAgentOptions = useMemo(
    () => findMatchingTabAgentLaunchOptions(query, agentOptions),
    [agentOptions, query]
  )

  useEffect(() => {
    onQueryChange?.(query)
  }, [onQueryChange, query])

  if (selectedIndexQuery !== query) {
    setSelectedIndexQuery(query)
    if (selectedIndex !== 0) {
      // Why: the first filtered action should be highlighted on the same paint as the new query.
      setSelectedIndex(0)
    }
  }

  if (lastMenuOpen !== menuOpen) {
    setLastMenuOpen(menuOpen)
    if (!menuOpen) {
      setQuery('')
      setPending(false)
      setError(null)
      setSelectedIndex(0)
    }
  }

  const disabled = !onOpenEntry
  const hasQuery = query.trim().length > 0
  const activeOptions: ActiveOption[] = [
    ...matchingMenuOptions.map((option) => ({
      kind: 'menu' as const,
      option
    })),
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
      : 'Open any file, URL, agent, ...'

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
    if (selectedOption.kind === 'menu') {
      onSelectMenuOption?.(selectedOption.option)
      onDidOpenEntry?.()
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
      className="pb-1"
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
      <div className="-mx-1 flex items-center px-3">
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setError(null)
          }}
          disabled={disabled}
          aria-label={translate(
            'auto.components.tab.bar.TabBarCreateEntry.39676a184c',
            'Open any file, URL, agent, ...'
          )}
          aria-invalid={error ? true : undefined}
          placeholder={translate(
            'auto.components.tab.bar.TabBarCreateEntry.39676a184c',
            'Open any file, URL, agent, ...'
          )}
          className="h-9 rounded-none border-0 bg-transparent px-0 text-xs font-normal text-foreground shadow-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 aria-invalid:border-0 aria-invalid:ring-0 md:text-xs dark:bg-transparent"
        />
      </div>
      {error || activeOptions.length > 0 || hasQuery ? (
        <div className="mt-1 space-y-0.5 px-1">
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
  | {
      kind: 'menu'
      option: TabCreateMenuOption
    }

function isActiveEntryOption(option: TabEntryOption): option is ActiveEntryOption {
  return option.classification.kind !== 'empty' && option.classification.kind !== 'blocked'
}

function getActiveOptionId(option: ActiveOption): string {
  if (option.kind === 'agent') {
    return `agent:${option.option.agent}`
  }
  if (option.kind === 'menu') {
    return `menu:${option.option.id}`
  }
  return option.option.id
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
      <span className={cn('min-w-0 truncate font-medium', presentation.showDetail && 'shrink-0')}>
        {presentation.label}
      </span>
      {presentation.showDetail ? (
        <>
          <span className="text-muted-foreground/70" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 truncate">{presentation.detail}</span>
        </>
      ) : null}
    </button>
  )
}

function getActionPresentation(option: ActiveOption): {
  detail: string
  icon: React.ReactNode
  label: string
  showDetail: boolean
} {
  if (option.kind === 'menu') {
    const icon =
      option.option.kind === 'new-browser' ? (
        <Globe className="size-3.5 shrink-0" aria-hidden="true" />
      ) : option.option.kind === 'new-markdown' ? (
        <FilePlus className="size-3.5 shrink-0" aria-hidden="true" />
      ) : option.option.kind === 'open-markdown' ? (
        <FileText className="size-3.5 shrink-0" aria-hidden="true" />
      ) : option.option.kind === 'new-simulator' || option.option.kind === 'go-to-simulator' ? (
        <Smartphone className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <TerminalSquare className="size-3.5 shrink-0" aria-hidden="true" />
      )
    return {
      detail: '',
      icon,
      label: option.option.label,
      showDetail: false
    }
  }
  if (option.kind === 'agent') {
    return {
      detail: option.option.label,
      icon: <AgentIcon agent={option.option.agent} size={14} />,
      label: translate('auto.components.tab.bar.TabBarCreateEntry.b27864279e', 'Launch agent'),
      showDetail: true
    }
  }
  const { classification } = option.option
  if (classification.kind === 'explicit-url' || classification.kind === 'host-url') {
    return {
      detail: classification.url,
      icon: <Globe className="size-3.5 shrink-0" aria-hidden="true" />,
      label: translate('auto.components.tab.bar.TabBarCreateEntry.7cdf8ee0c8', 'Open URL'),
      showDetail: true
    }
  }
  if (classification.kind === 'existing-file') {
    return {
      detail: classification.relativePath,
      icon: <FileText className="size-3.5 shrink-0" aria-hidden="true" />,
      label: translate('auto.components.tab.bar.TabBarCreateEntry.25dc1cd653', 'Open file'),
      showDetail: true
    }
  }
  return {
    detail: classification.relativePath,
    icon: <FilePlus className="size-3.5 shrink-0" aria-hidden="true" />,
    label: translate('auto.components.tab.bar.TabBarCreateEntry.d62d63b807', 'Create file'),
    showDetail: true
  }
}
