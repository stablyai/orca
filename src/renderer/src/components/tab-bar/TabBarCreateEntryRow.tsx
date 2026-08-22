import React from 'react'
import {
  FilePlus,
  FileText,
  GitCompare,
  Globe,
  Loader2,
  Search,
  Smartphone,
  TerminalSquare
} from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { FilePathCursorTooltip, splitTrailingSegment } from '@/components/file-path-cursor-tooltip'
import { translate } from '@/i18n/i18n'
import { SEARCH_ENGINE_LABELS } from '../../../../shared/browser-url'
import type { ActiveOption } from './tab-create-entry-active-option'

export const RESULT_LISTBOX_ID = 'tab-create-entry-results'

// Index-based (not the option id, which may contain spaces/slashes from file
// paths) so it is always a valid aria-activedescendant IDREF.
export function resultOptionDomId(index: number): string {
  return `tab-create-entry-result-${index}`
}

export function EntryStatusRow({
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

export function EntryActionRow({
  disabled = false,
  id,
  loading = false,
  onClick,
  option,
  selected
}: {
  disabled?: boolean
  id: string
  loading?: boolean
  onClick: () => void
  option: ActiveOption
  selected: boolean
}): React.JSX.Element {
  const presentation = getActionPresentation(option)

  const row = (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      disabled={disabled}
      className={cn(
        'flex h-6 w-full items-center gap-1.5 rounded-[7px] px-1 text-left text-[11px] leading-5 outline-none disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'bg-black/8 text-accent-foreground dark:bg-white/14'
          : // Why: CSS :hover still matches a disabled button, so a pending row would
            // light up under the pointer despite being unactivatable.
            'text-muted-foreground hover:bg-black/8 hover:text-accent-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground dark:hover:bg-white/14 dark:disabled:hover:bg-transparent'
      )}
      onClick={onClick}
    >
      {loading ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        presentation.icon
      )}
      <span className={cn('min-w-0 truncate font-medium', presentation.showDetail && 'shrink-0')}>
        {presentation.label}
      </span>
      {presentation.showDetail ? (
        <>
          <span className="shrink-0 text-muted-foreground/70" aria-hidden="true">
            ·
          </span>
          {presentation.prioritizeFilename ? (
            <FilenameFirstPath path={presentation.detail} />
          ) : (
            <span className="min-w-0 flex-1 truncate">{presentation.detail}</span>
          )}
        </>
      ) : null}
    </button>
  )

  // Only the filename-first rows hide information. Every other row already shows
  // its detail in full, and STYLEGUIDE.md:162 rules out labelling those.
  if (!presentation.prioritizeFilename) {
    return row
  }

  return <FilePathCursorTooltip path={presentation.detail}>{row}</FilePathCursorTooltip>
}

function FilenameFirstPath({ path }: { path: string }): React.JSX.Element {
  const { directory, filename } = splitTrailingSegment(path)

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      {/* shrink-0 + max-w-full: the directory gives up all of its width before
          the filename loses a character. */}
      <span className="min-w-0 max-w-full shrink-0 truncate">{filename}</span>
      {directory ? (
        <span className="min-w-0 truncate text-muted-foreground/70">{directory}</span>
      ) : null}
    </span>
  )
}

function getOpenTabIcon(option: Extract<ActiveOption, { kind: 'tab' }>['option']): React.ReactNode {
  if (option.contentType === 'terminal' && option.source === 'workspace' && option.occupantAgent) {
    return (
      <span
        className="inline-flex shrink-0"
        data-agent-icon={option.occupantAgent}
        aria-hidden="true"
      >
        <AgentIcon agent={option.occupantAgent} size={14} />
      </span>
    )
  }
  const { contentType } = option
  if (contentType === 'terminal') {
    return <TerminalSquare className="size-3.5 shrink-0" aria-hidden="true" />
  }
  if (contentType === 'browser') {
    return <Globe className="size-3.5 shrink-0" aria-hidden="true" />
  }
  if (contentType === 'simulator') {
    return <Smartphone className="size-3.5 shrink-0" aria-hidden="true" />
  }
  if (contentType === 'editor') {
    return <FileText className="size-3.5 shrink-0" aria-hidden="true" />
  }
  return <GitCompare className="size-3.5 shrink-0" aria-hidden="true" />
}

function getActionPresentation(option: ActiveOption): {
  detail: string
  icon: React.ReactNode
  label: string
  prioritizeFilename?: boolean
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
  if (option.kind === 'tab') {
    return {
      detail: option.option.matchedText ?? option.option.title,
      icon: getOpenTabIcon(option.option),
      label: translate('auto.components.tab.bar.TabBarCreateEntry.8f0a1c4d92', 'Switch to tab'),
      showDetail: true
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
  if (classification.kind === 'search') {
    return {
      detail: classification.query,
      icon: <Search className="size-3.5 shrink-0" aria-hidden="true" />,
      label: translate(
        'auto.components.tab.bar.TabBarCreateEntry.searchProvider',
        'Search {{value0}}',
        { value0: SEARCH_ENGINE_LABELS[classification.engine] }
      ),
      prioritizeFilename: false,
      showDetail: true
    }
  }
  if (classification.kind === 'explicit-url' || classification.kind === 'host-url') {
    return {
      detail: classification.url,
      icon: <Globe className="size-3.5 shrink-0" aria-hidden="true" />,
      label: translate('auto.components.tab.bar.TabBarCreateEntry.7cdf8ee0c8', 'Open URL'),
      showDetail: true
    }
  }
  if (classification.kind === 'existing-file' || classification.kind === 'absolute-file') {
    return {
      detail:
        classification.kind === 'absolute-file'
          ? classification.filePath
          : classification.relativePath,
      icon: <FileText className="size-3.5 shrink-0" aria-hidden="true" />,
      label: translate('auto.components.tab.bar.TabBarCreateEntry.25dc1cd653', 'Open file'),
      prioritizeFilename: true,
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
