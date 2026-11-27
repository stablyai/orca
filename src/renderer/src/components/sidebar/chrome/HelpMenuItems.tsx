import React from 'react'
import {
  BookOpen,
  ExternalLink,
  Github,
  Keyboard,
  Loader2,
  MessageSquareText,
  RefreshCw,
  RotateCw,
  School,
  ScrollText
} from 'lucide-react'
import logo from '../../../../../../resources/logo.svg'
import { DiscordIcon } from '../../icons/DiscordIcon'
import { useAppStore } from '@/store/index'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { showOnboardingFromRenderer } from '../../onboarding/show-onboarding-event'
import { SetupGuideProgressRing } from '../../setup-guide/SetupGuideProgressRing'
import { useTranslate } from '@/i18n/use-translate'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import { openHelpLink } from './help-link-open'
import type { HelpMenuDividers, SetupMilestones } from './help-menu-controller'

const DOCS_URL = 'https://orca.dev/docs'
const CHANGELOG_URL = 'https://orca.dev/changelog'
const GITHUB_URL = 'https://github.com/stablyai/orca'
const DISCORD_URL = 'https://discord.gg/fzjDKHxv8Q'
const X_URL = 'https://x.com/orca_build'
const NO_UPDATE_CHECK_MODIFIERS = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false
}

function XIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 fill-current">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function ExternalMenuItem({
  label,
  url,
  icon
}: {
  label: string
  url: string
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={() => openHelpLink(url)}>
      {icon}
      {label}
      <ExternalLink className="ml-auto size-3 text-muted-foreground" />
    </DropdownMenuItem>
  )
}

/** Help's Milestones row (opens the setup guide). `badge` shows done/total as text (the rail's account menu). */
export function MilestonesMenuItemContent({
  milestones,
  progress = 'ring'
}: {
  milestones: SetupMilestones
  progress?: 'ring' | 'badge'
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuItem
      onSelect={() =>
        useAppStore.getState().openModal('setup-guide', { telemetrySource: 'help_menu' })
      }
    >
      <img
        src={logo}
        alt=""
        aria-hidden="true"
        className="size-3.5 object-contain invert opacity-55 dark:invert-0"
      />
      {t('auto.components.sidebar.SidebarSettingsHelpMenu.f8a2c91d4e', 'Milestones')}
      {progress === 'badge' ? (
        <span className="ml-auto rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground tabular-nums">
          {milestones.done}/{milestones.total}
        </span>
      ) : (
        <SetupGuideProgressRing
          done={milestones.done}
          total={milestones.total}
          sizeClassName="size-4"
          className="ml-auto"
        />
      )}
    </DropdownMenuItem>
  )
}

export function HelpMenuItems({
  milestones,
  dividers,
  isRestartingOrca,
  onRestartOrca,
  onOpenFeedback,
  lastShowOnboardingAtRef
}: {
  milestones: SetupMilestones | null
  dividers: HelpMenuDividers
  isRestartingOrca: boolean
  onRestartOrca: () => void
  onOpenFeedback: () => void
  lastShowOnboardingAtRef: React.RefObject<number>
}): React.JSX.Element {
  const t = useTranslate()
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const updateCheckModifiersRef = React.useRef(NO_UPDATE_CHECK_MODIFIERS)
  const updateCheckHint = getUpdateCheckHint()

  const handleShowOnboarding = (): void => {
    const now = Date.now()
    if (now - lastShowOnboardingAtRef.current < 500) {
      return
    }
    lastShowOnboardingAtRef.current = now
    void showOnboardingFromRenderer()
  }

  const openShortcutsSettings = (): void => {
    openSettingsTarget({ pane: 'shortcuts', repoId: null })
    openSettingsPage()
  }

  const handleCheckForUpdatesPointerDown = (event: React.PointerEvent): void => {
    updateCheckModifiersRef.current = {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey
    }
  }

  const handleCheckForUpdates = (): void => {
    const modifiers = updateCheckModifiersRef.current
    updateCheckModifiersRef.current = NO_UPDATE_CHECK_MODIFIERS
    void window.api.updater.check(getUpdateCheckClickOptions(modifiers))
  }

  // Dividers that only the standalone Help menu shows.
  const innerSeparator = dividers === 'default' ? <DropdownMenuSeparator /> : null

  return (
    <>
      <DropdownMenuItem onSelect={openShortcutsSettings}>
        <Keyboard className="size-3.5" />
        {t('auto.components.sidebar.SidebarSettingsHelpMenu.e565171a7c', 'Keyboard Shortcuts')}
      </DropdownMenuItem>
      {innerSeparator}
      <DropdownMenuItem onSelect={onOpenFeedback}>
        <MessageSquareText className="size-3.5" />
        {t('auto.components.sidebar.SidebarSettingsHelpMenu.4cf5b868d7', 'Send Feedback')}
      </DropdownMenuItem>
      {milestones ? <MilestonesMenuItemContent milestones={milestones} /> : null}
      <DropdownMenuItem
        className="whitespace-nowrap"
        onClick={handleShowOnboarding}
        onSelect={handleShowOnboarding}
      >
        <School className="size-3.5" />
        {t('auto.components.sidebar.SidebarSettingsHelpMenu.b7e4d2a19c', 'Onboarding')}
      </DropdownMenuItem>
      <ExternalMenuItem
        label={t('auto.components.sidebar.SidebarSettingsHelpMenu.cdc87f897e', 'Docs')}
        url={DOCS_URL}
        icon={<BookOpen className="size-3.5" />}
      />
      <ExternalMenuItem
        label={t('auto.components.sidebar.SidebarSettingsHelpMenu.5f83d86d92', 'Changelog')}
        url={CHANGELOG_URL}
        icon={<ScrollText className="size-3.5" />}
      />
      {innerSeparator}
      <ExternalMenuItem
        label={t('auto.components.sidebar.SidebarSettingsHelpMenu.5687ab246a', 'GitHub')}
        url={GITHUB_URL}
        icon={<Github className="size-3.5" />}
      />
      <DropdownMenuItem onSelect={() => openHelpLink(DISCORD_URL)}>
        <DiscordIcon className="size-3.5" />
        {t('auto.components.sidebar.SidebarSettingsHelpMenu.eb9884e55b', 'Discord')}
        <ExternalLink className="ml-auto size-3 text-muted-foreground" />
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => openHelpLink(X_URL)}>
        <XIcon />
        {t('auto.components.sidebar.SidebarSettingsHelpMenu.c4f8e1b72a', 'X')}
        <ExternalLink className="ml-auto size-3 text-muted-foreground" />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
        onPointerDown={handleCheckForUpdatesPointerDown}
        onSelect={handleCheckForUpdates}
        title={updateCheckHint}
      >
        {updateStatus.state === 'checking' ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        {t('auto.components.sidebar.SidebarSettingsHelpMenu.29c56f30ee', 'Check for Updates')}
      </DropdownMenuItem>
      {innerSeparator}
      <DropdownMenuItem onSelect={onRestartOrca} disabled={isRestartingOrca}>
        <RotateCw className="size-3.5" />
        {t('auto.components.sidebar.SidebarSettingsHelpMenu.ad3d3ed7f1', 'Restart Orca')}
      </DropdownMenuItem>
    </>
  )
}
