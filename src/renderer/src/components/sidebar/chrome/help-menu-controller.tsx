import { DiscordIcon } from '../../icons/DiscordIcon'
import React, { useState } from 'react'
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
import { toast } from 'sonner'
import logo from '../../../../../../resources/logo.svg'
import { useAppStore } from '@/store/index'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useMountedRef } from '@/hooks/useMountedRef'
import { showOnboardingFromRenderer } from '../../onboarding/show-onboarding-event'
import { SetupGuideProgressRing } from '../../setup-guide/SetupGuideProgressRing'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import type * as SidebarFeedbackDialogModule from '../sidebar-feedback/SidebarFeedbackDialog'
import { useTranslate } from '@/i18n/use-translate'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import { openHelpLink } from './help-link-open'

// Keep feedback off the boot graph; menu warming and selection share the same lazy module entry.
const loadSidebarFeedbackDialog = (): Promise<typeof SidebarFeedbackDialogModule> =>
  import('../sidebar-feedback/SidebarFeedbackDialog')

const SidebarFeedbackDialog = lazyWithRetry(
  () => loadSidebarFeedbackDialog().then((module) => ({ default: module.SidebarFeedbackDialog })),
  { reloadKey: 'sidebar-feedback-dialog' }
)

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

export type SetupMilestones = { done: number; total: number }

/** Help's Milestones row (opens the setup guide). `badge` shows done/total as text (the rail's account menu). */
export function MilestonesMenuItem({
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

/** Help's menu rows and feedback dialog, so the same Help can open from its own button or as a More submenu. */
export type HelpMenuController = {
  items: React.ReactNode
  dialog: React.ReactNode
  handleMenuOpenChange: (open: boolean) => void
}

export function useHelpMenuController(milestones: SetupMilestones | null): HelpMenuController {
  const t = useTranslate()
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Retain the mounted dialog through its closing animation.
  const [feedbackDialogMounted, setFeedbackDialogMounted] = useState(false)
  const [isRestartingOrca, setIsRestartingOrca] = useState(false)
  const lastShowOnboardingAtRef = React.useRef(0)
  const updateCheckModifiersRef = React.useRef(NO_UPDATE_CHECK_MODIFIERS)
  const mountedRef = useMountedRef()
  const updateCheckHint = getUpdateCheckHint()

  const handleMenuOpenChange = (open: boolean): void => {
    updateCheckModifiersRef.current = NO_UPDATE_CHECK_MODIFIERS
    if (open) {
      // Warm while users read the menu so feedback is loaded before selection.
      void loadSidebarFeedbackDialog().catch(() => {})
    }
  }

  const handleOpenFeedback = (): void => {
    setFeedbackDialogMounted(true)
    setFeedbackOpen(true)
  }

  const handleShowOnboarding = (): void => {
    const now = Date.now()
    if (now - lastShowOnboardingAtRef.current < 500) {
      return
    }
    lastShowOnboardingAtRef.current = now
    void showOnboardingFromRenderer()
  }

  const handleRestartOrca = (): void => {
    if (isRestartingOrca) {
      return
    }
    setIsRestartingOrca(true)
    toast.info(t('auto.components.sidebar.SidebarSettingsHelpMenu.5161eef55d', 'Restarting Orca…'))
    void window.api.app.restart().catch((error) => {
      if (mountedRef.current) {
        setIsRestartingOrca(false)
        toast.error(
          t('auto.components.sidebar.SidebarSettingsHelpMenu.4e8f5710d3', "Couldn't restart Orca."),
          {
            description: error instanceof Error ? error.message : undefined
          }
        )
      }
    })
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

  return {
    items: (
      <>
        <DropdownMenuItem onSelect={openShortcutsSettings}>
          <Keyboard className="size-3.5" />
          {t('auto.components.sidebar.SidebarSettingsHelpMenu.e565171a7c', 'Keyboard Shortcuts')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleOpenFeedback}>
          <MessageSquareText className="size-3.5" />
          {t('auto.components.sidebar.SidebarSettingsHelpMenu.4cf5b868d7', 'Send Feedback')}
        </DropdownMenuItem>
        {milestones ? <MilestonesMenuItem milestones={milestones} /> : null}
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
        <DropdownMenuSeparator />
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
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleRestartOrca} disabled={isRestartingOrca}>
          <RotateCw className="size-3.5" />
          {t('auto.components.sidebar.SidebarSettingsHelpMenu.ad3d3ed7f1', 'Restart Orca')}
        </DropdownMenuItem>
      </>
    ),
    dialog: (
      <>
        {feedbackDialogMounted ? (
          <React.Suspense fallback={null}>
            <SidebarFeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
          </React.Suspense>
        ) : null}
      </>
    ),
    handleMenuOpenChange
  }
}
