import { tabAgentLaunchOptionDisabled } from './tab-agent-launch-options'
import { terminalPendingLabel } from './new-tab-agent-menu-model'
import React, { useEffect, useRef, useState } from 'react'
import {
  FilePlus,
  FileText,
  GitCompare,
  Globe,
  Loader2,
  MessageSquare,
  Search,
  Smartphone,
  TerminalSquare
} from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { PluginContributionIcon } from '../plugins/PluginContributionIcon'
import { cn } from '@/lib/class-names'
import { FilePathCursorTooltip, FilenameFirstPath } from '@/components/file-path-cursor-tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SEARCH_ENGINE_LABELS } from '../../../../shared/browser-url'
import { formatBrowserHistoryUrl } from '@/lib/browser/history/browser-history-match'
import type { ActiveOption } from './tab-create-entry-active-option'
import { BrowserFavicon } from '@/components/browser-favicon'
import { AgentLaunchSetupButton } from '../agent/AgentLaunchSetupButton'
import type { AgentPickerDraft } from '../../../../shared/agent-launch/picker/agent-launch-picker'

export const RESULT_LISTBOX_ID = 'tab-create-entry-results'

// Use index-based DOM IDs because option paths can contain spaces invalid in aria-activedescendant references.
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

/** Keeps one agent setup submenu open at a time, keyed by result option id. */
export function useEntrySetupSubmenu(): {
  openId: string | null
  change: (optionId: string, open: boolean) => void
  hover: (optionId: string) => void
} {
  const [openId, setOpenId] = useState<string | null>(null)
  const closeTimer = useRef<number | null>(null)
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  useEffect(() => cancelClose, [])
  return {
    openId,
    change: (optionId, open) => {
      cancelClose()
      setOpenId((current) => (open ? optionId : current === optionId ? null : current))
    },
    hover: (optionId) => {
      if (openId === optionId) {
        cancelClose()
      } else if (openId !== null && closeTimer.current === null) {
        // Why: like Radix's submenu pointer grace, crossing another row on the way to the panel must not close it.
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null
          setOpenId((current) => (current === openId ? null : current))
        }, 300)
      }
    }
  }
}

export function EntryActionRow({
  disabled: rowDisabled = false,
  id,
  labelOverride,
  loading = false,
  onClick,
  onHover,
  onSetupOpenChange,
  onUseAgent,
  option,
  selected,
  setupOpen,
  terminalPending
}: {
  disabled?: boolean
  id: string
  labelOverride?: string
  loading?: boolean
  onClick: () => void
  /** Pointer moved over this row; closes another row's open setup like a native submenu. */
  onHover?: () => void
  onSetupOpenChange?: (open: boolean) => void
  onUseAgent?: (draft: AgentPickerDraft) => boolean | void | Promise<boolean>
  option: ActiveOption
  selected: boolean
  setupOpen?: boolean
  terminalPending?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const presentation = getActionPresentation(option, labelOverride, t)
  const agentOption = option.kind === 'agent' ? option.option : null
  const launchDisabled = rowDisabled || (!!agentOption && tabAgentLaunchOptionDisabled(agentOption))
  const setupEntry = onUseAgent ? agentOption?.pickerEntry : undefined
  const buttonRef = useRef<HTMLButtonElement>(null)
  const focusSearchInput = () =>
    buttonRef.current?.closest('form')?.querySelector('input')?.focus({ preventScroll: true })

  const button = (
    <button
      ref={buttonRef}
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      disabled={launchDisabled}
      className={cn(
        // Why min-w-0: a long agent setup must truncate so the row's › stays inside the menu.
        'flex h-6 w-full min-w-0 items-center gap-1.5 rounded-[7px] px-1 text-left text-[11px] leading-5 font-normal outline-none disabled:cursor-not-allowed',
        // The launch-row trigger already dims a disabled setup row.
        !(setupEntry && rowDisabled) && 'disabled:opacity-50',
        setupEntry
          ? // The submenu row owns the highlight so it spans the › segment.
            cn(
              'rounded-r-none',
              selected
                ? 'text-accent-foreground'
                : 'text-muted-foreground group-hover/setup-row:text-accent-foreground'
            )
          : selected
            ? 'bg-black/8 text-accent-foreground dark:bg-white/14'
            : // Why: CSS :hover still matches a disabled button, so a pending row would
              // light up under the pointer despite being unactivatable.
              'text-muted-foreground hover:bg-black/8 hover:text-accent-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground dark:hover:bg-white/14 dark:disabled:hover:bg-transparent'
      )}
      onClick={onClick}
      onPointerMove={setupEntry ? undefined : onHover}
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

  const row =
    agentOption && setupEntry && onUseAgent ? (
      // Why: the portaled panel is a React child here, so moves inside it keep this row's setup open.
      <div role="none" onPointerMove={onHover}>
        <AgentLaunchSetupButton
          entry={setupEntry}
          seed={agentOption.setup}
          preset={agentOption.preset}
          draftId={
            agentOption.preset
              ? `${agentOption.preset.model}:${agentOption.preset.effort ?? ''}`
              : undefined
          }
          disabled={rowDisabled}
          open={setupOpen}
          onOpenChange={onSetupOpenChange}
          terminalBlocked={terminalPending}
          onUse={onUseAgent}
          returnFocus={focusSearchInput}
          renderAnchor={(trigger) => (
            // Why role none: the search input drives these listbox options; the › carries the submenu semantics.
            <div
              role="none"
              data-agent-launch-row
              className={cn('group/setup-row flex', selected && 'bg-black/8 dark:bg-white/14')}
              // Why: hovering must not move focus off the search input, as Radix menu items do.
              onPointerMove={(event) => event.preventDefault()}
              onPointerLeave={(event) => {
                if (event.currentTarget.getAttribute('data-state') !== 'open') {
                  event.preventDefault()
                }
              }}
              onFocus={(event) => {
                if (event.target === event.currentTarget) {
                  focusSearchInput()
                }
              }}
              onClick={(event) => {
                // The option button launches; only the › opens setup.
                event.preventDefault()
              }}
            >
              {button}
              {trigger}
            </div>
          )}
        />
      </div>
    ) : (
      button
    )

  // Only the filename-first rows hide information. Every other row already shows
  // its detail in full, and the STYLEGUIDE tooltip rule rules out labelling those.
  if (!presentation.prioritizeFilename) {
    return row
  }

  return <FilePathCursorTooltip path={presentation.detail}>{row}</FilePathCursorTooltip>
}

function getOpenTabIcon(option: Extract<ActiveOption, { kind: 'tab' }>['option']): React.ReactNode {
  if (option.source === 'workspace' && option.occupantAgent) {
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
    return <BrowserFavicon faviconUrl={option.faviconUrl} className="size-3.5" />
  }
  if (contentType === 'simulator') {
    return <Smartphone className="size-3.5 shrink-0" aria-hidden="true" />
  }
  if (contentType === 'editor') {
    return <FileText className="size-3.5 shrink-0" aria-hidden="true" />
  }
  if (contentType === 'agent-session') {
    return <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
  }
  return <GitCompare className="size-3.5 shrink-0" aria-hidden="true" />
}

function getActionPresentation(
  option: ActiveOption,
  labelOverride?: string,
  t: Translate = translate
): {
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
      ) : option.option.kind === 'new-plugin-file' ? (
        <PluginContributionIcon
          url={option.option.pluginNewFile?.iconUrl}
          fallback={FilePlus}
          className="size-3.5 shrink-0"
        />
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
      detail: option.option.matchedTexts?.length
        ? option.option.matchedTexts.join(' · ')
        : (option.option.matchedText ?? option.option.title),
      icon: getOpenTabIcon(option.option),
      label: t('auto.components.tab.bar.TabBarCreateEntry.8f0a1c4d92', 'Switch to tab'),
      showDetail: true
    }
  }
  if (option.kind === 'history') {
    const { entry } = option.option
    const url = formatBrowserHistoryUrl(entry.url)
    return {
      // Put variable titles in the truncating detail slot; labels with detail cannot shrink.
      detail: entry.title ? `${entry.title} · ${url}` : url,
      icon: <BrowserFavicon faviconUrl={entry.faviconUrl} className="size-3.5" />,
      label: t('auto.components.tab.bar.TabBarCreateEntry.openPage', 'Open page'),
      showDetail: true
    }
  }
  if (option.kind === 'agent') {
    return {
      detail: [
        option.option.label,
        option.option.reason ??
          (option.option.terminalWaiting ? terminalPendingLabel(t) : undefined)
      ]
        .filter(Boolean)
        .join(' · '),
      icon: <AgentIcon agent={option.option.agent} size={14} />,
      label:
        labelOverride ?? t('auto.components.tab.bar.TabBarCreateEntry.b27864279e', 'Launch agent'),
      showDetail: true
    }
  }
  const { classification } = option.option
  if (classification.kind === 'search') {
    return {
      detail: classification.query,
      icon: <Search className="size-3.5 shrink-0" aria-hidden="true" />,
      label: t('auto.components.tab.bar.TabBarCreateEntry.searchProvider', 'Search {{value0}}', {
        value0: SEARCH_ENGINE_LABELS[classification.engine]
      }),
      prioritizeFilename: false,
      showDetail: true
    }
  }
  if (classification.kind === 'explicit-url' || classification.kind === 'host-url') {
    return {
      detail: classification.url,
      icon: <Globe className="size-3.5 shrink-0" aria-hidden="true" />,
      label: t('auto.components.tab.bar.TabBarCreateEntry.7cdf8ee0c8', 'Open URL'),
      showDetail: true
    }
  }
  if (
    classification.kind === 'existing-file' ||
    classification.kind === 'absolute-file' ||
    classification.kind === 'html-file-url'
  ) {
    return {
      detail:
        classification.kind === 'existing-file'
          ? classification.relativePath
          : classification.filePath,
      icon: <FileText className="size-3.5 shrink-0" aria-hidden="true" />,
      label: t('auto.components.tab.bar.TabBarCreateEntry.25dc1cd653', 'Open file'),
      prioritizeFilename: true,
      showDetail: true
    }
  }
  return {
    detail: classification.relativePath,
    icon: <FilePlus className="size-3.5 shrink-0" aria-hidden="true" />,
    label: t('auto.components.tab.bar.TabBarCreateEntry.d62d63b807', 'Create file'),
    showDetail: true
  }
}
