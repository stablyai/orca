// A bot's settings: one view with a root and drill-in subpages, shown by two hosts, the bot's right panel
// (its header gear) and Settings › Bots. Hosts differ only in width, scrolling and where Back goes from the root.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ChevronLeft, CloudOff } from 'lucide-react'
import { BreadcrumbButton } from '@/components/ui/breadcrumb-button'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { useBotHome } from '../../settings/bots/use-bot-home-file'
import { updateBotReporting } from '../bot-update-reporting'
import { useBotComputerName } from './BotComputerPage'
import {
  createBotSettingsLeaveGuards,
  BotSettingsLeaveGuardContext
} from './bot-settings-leave-guard'
import {
  type BotSettingsHost,
  type BotSettingsPage,
  botSettingsPageTitle,
  setBotSettingsPlace,
  useBotSettingsPlace
} from './bot-settings-place'
import { BotSettingsRoot } from './BotSettingsRoot'
import { SettingsControlsOffContext } from './BotSettingsRows'
import { BotSettingsSubpage } from './BotSettingsSubpage'
import { useBotPicturePaste } from './use-bot-picture-paste'

/** Where a crumb goes: the settings root, or out of the view as Back from the root does. */
type CrumbTarget = 'root' | 'exit'

function Crumb({
  bot,
  page,
  host,
  go
}: {
  bot: Bot
  page: BotSettingsPage | null
  host: BotSettingsHost
  go: (to: CrumbTarget) => void
}): React.JSX.Element {
  const t = useTranslate()
  const settings = t('bots.panel.settings.title', 'Settings')
  const back = page
    ? t('bots.settingsView.backToSettings', 'Back to Settings')
    : host === 'panel'
      ? t('bots.settingsView.backToItems', 'Back to Items')
      : t('bots.settingsView.backToBots', 'Back to Bots')
  const sep = (
    <span aria-hidden className="shrink-0 text-muted-foreground">
      /
    </span>
  )
  return (
    <nav
      aria-label={t('bots.settingsView.crumb', 'Bot settings')}
      className={cn(
        'flex h-11 min-w-0 shrink-0 items-center gap-1 text-[13px]',
        host === 'panel' ? 'border-b border-border pr-2.5 pl-1.5' : null
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={back}
        title={back}
        onClick={() => go(page ? 'root' : 'exit')}
      >
        <ChevronLeft />
      </Button>
      <BreadcrumbButton onClick={() => go('exit')}>{bot.name}</BreadcrumbButton>
      {sep}
      {page ? (
        <>
          <BreadcrumbButton
            className="shrink-0 @max-[300px]/settings-view:hidden"
            onClick={() => go('root')}
          >
            {settings}
          </BreadcrumbButton>
          <span className="contents @max-[300px]/settings-view:hidden">{sep}</span>
          <span aria-current="page" className="shrink-0 font-semibold whitespace-nowrap">
            {botSettingsPageTitle(page)}
          </span>
        </>
      ) : (
        <span aria-current="page" className="shrink-0 font-semibold">
          {settings}
        </span>
      )}
    </nav>
  )
}

/** Focus after a screen change: the row Back came from, else the screen itself, unless it is elsewhere. */
function focusScreen(node: HTMLElement, cameFrom: BotSettingsPage | null): void {
  const active = document.activeElement
  if (active && active !== document.body && !node.contains(active)) {
    return
  }
  const row = cameFrom
    ? node.querySelector<HTMLElement>(`[data-settings-page="${cameFrom}"]`)
    : null
  ;(row ?? node.querySelector<HTMLElement>('[data-settings-screen]'))?.focus()
}

export function BotSettingsView({
  bot,
  host,
  onExit,
  onDeleted
}: {
  bot: Bot
  host: BotSettingsHost
  /** Back from the root: to Activity in the panel, to the Bots list in Settings. */
  onExit: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const place = useBotSettingsPlace(host, bot.id)
  const page = place?.page ?? null
  const home = useBotHome(bot)
  const offline = useBotHostOffline(bot.hostId)
  const computer = useBotComputerName(bot)
  const t = useTranslate()
  const onPaste = useBotPicturePaste(bot)
  const update = useCallback(
    (updates: BotUpdateParams['updates']) => updateBotReporting(bot, updates),
    [bot]
  )
  const guards = useMemo(() => createBotSettingsLeaveGuards(), [])
  // The subpage Back left, whose row takes focus on the root.
  const cameFrom = useRef<BotSettingsPage | null>(null)

  const open = (next: BotSettingsPage): void => {
    cameFrom.current = null
    setBotSettingsPlace(host, { botId: bot.id, page: next })
  }
  const go = useCallback(
    async (to: CrumbTarget): Promise<void> => {
      if (page && !(await guards.ask())) {
        return
      }
      if (to === 'exit') {
        onExit()
        return
      }
      cameFrom.current = page
      setBotSettingsPlace(host, { botId: bot.id, page: null })
    },
    [bot.id, guards, host, onExit, page]
  )
  const back = useCallback(() => go(page ? 'root' : 'exit'), [go, page])

  // Settings closes on a document-level Escape, so below the root this host takes it first.
  useEffect(() => {
    if (host !== 'page' || !page) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
        return
      }
      if (hasVisibleOverlay()) {
        return
      }
      event.preventDefault()
      void back()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [back, host, page])

  const showScreen = useCallback((node: HTMLDivElement | null): void => {
    if (node) {
      focusScreen(node, cameFrom.current)
    }
  }, [])

  return (
    <BotSettingsLeaveGuardContext.Provider value={guards}>
      <div
        // A new screen starts at its top, with focus on it.
        key={page ?? 'root'}
        ref={showScreen}
        onPaste={onPaste}
        onKeyDown={(event) => {
          // The panel takes Escape only from inside itself; dialogs and menus are portaled outside it.
          if (
            host !== 'panel' ||
            event.key !== 'Escape' ||
            event.nativeEvent.isComposing ||
            event.defaultPrevented ||
            !(event.target instanceof Node && event.currentTarget.contains(event.target))
          ) {
            return
          }
          event.preventDefault()
          void back()
        }}
        className={cn(
          '@container/settings-view flex min-w-0 flex-col',
          host === 'panel' ? 'min-h-0 flex-1' : 'mx-auto w-full max-w-[680px]'
        )}
      >
        <Crumb bot={bot} page={page} host={host} go={(to) => void go(to)} />
        <div
          data-settings-screen=""
          role="region"
          tabIndex={-1}
          aria-label={
            page ? botSettingsPageTitle(page) : t('bots.panel.settings.title', 'Settings')
          }
          className={cn(
            'flex min-w-0 flex-col gap-[18px] outline-none',
            host === 'panel'
              ? 'scrollbar-sleek min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pt-3.5 pb-6'
              : 'pt-2 pb-6'
          )}
        >
          {offline ? (
            <p role="status" className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
              <CloudOff className="mt-px size-3.5 shrink-0" />
              {t('settings.bots.group.offline', 'Can’t reach {{host}}', { host: computer })}
            </p>
          ) : null}
          {/* Its server is down: the last read shows dimmed. Rows still open their pages; controls are off. */}
          <SettingsControlsOffContext.Provider value={offline}>
            {place?.page ? (
              <fieldset
                disabled={offline}
                className={cn('flex min-w-0 flex-col gap-[18px]', offline ? 'opacity-60' : null)}
              >
                <BotSettingsSubpage
                  bot={bot}
                  home={home}
                  place={{ ...place, page: place.page }}
                  update={update}
                />
              </fieldset>
            ) : (
              <div
                className={cn('flex min-w-0 flex-col gap-[18px]', offline ? 'opacity-60' : null)}
              >
                <BotSettingsRoot
                  bot={bot}
                  home={home}
                  update={update}
                  open={open}
                  onDeleted={onDeleted}
                />
              </div>
            )}
          </SettingsControlsOffContext.Provider>
        </div>
      </div>
    </BotSettingsLeaveGuardContext.Provider>
  )
}
