import React, { useState } from 'react'
import {
  BookOpen,
  CircleHelp,
  ExternalLink,
  Github,
  Keyboard,
  Loader2,
  MessageSquareText,
  RefreshCw,
  RotateCw,
  School,
  ScrollText,
  Settings
} from 'lucide-react'
import { toast } from 'sonner'
import logo from '../../../../../resources/logo.svg'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { showOnboardingFromRenderer } from '../onboarding/show-onboarding-event'
import { SetupGuideProgressRing } from '../setup-guide/SetupGuideProgressRing'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'
import { SidebarFeedbackDialog } from './SidebarFeedbackDialog'
import { translate } from '@/i18n/i18n'

const DOCS_URL = 'https://www.onorca.dev/docs'
const CHANGELOG_URL = 'https://onorca.dev/changelog'
const GITHUB_URL = 'https://github.com/stablyai/orca'
const DISCORD_URL = 'https://discord.gg/fzjDKHxv8Q'
const X_URL = 'https://x.com/orca_build'

function openExternalUrl(url: string): void {
  void window.api.shell.openUrl(url)
}

function DiscordIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="size-3.5 fill-current">
      <path d="M16.0742 4.45014C14.9244 3.92097 13.7106 3.54556 12.4638 3.3335C12.2932 3.64011 12.1388 3.95557 12.0013 4.27856C10.6732 4.07738 9.32261 4.07738 7.99451 4.27856C7.85694 3.9556 7.70257 3.64014 7.53203 3.3335C6.28441 3.54735 5.06981 3.92365 3.91889 4.45291C1.63401 7.85128 1.01462 11.1652 1.32431 14.4322C2.6624 15.426 4.16009 16.1819 5.7523 16.6668C6.11082 16.1821 6.42806 15.6678 6.70066 15.1295C6.18289 14.9351 5.68315 14.6953 5.20723 14.4128C5.33249 14.3215 5.45499 14.2274 5.57336 14.136C6.95819 14.7907 8.46965 15.1302 9.99997 15.1302C11.5303 15.1302 13.0418 14.7907 14.4266 14.136C14.5463 14.2343 14.6688 14.3284 14.7927 14.4128C14.3159 14.6957 13.8152 14.9361 13.2965 15.1309C13.5688 15.669 13.8861 16.1828 14.2449 16.6668C15.8385 16.1838 17.3373 15.4283 18.6756 14.4335C19.039 10.645 18.0549 7.36145 16.0742 4.45014ZM7.09294 12.423C6.22992 12.423 5.51693 11.6357 5.51693 10.6671C5.51693 9.69852 6.20514 8.90427 7.09019 8.90427C7.97524 8.90427 8.68272 9.69852 8.66758 10.6671C8.65244 11.6357 7.97248 12.423 7.09294 12.423ZM12.907 12.423C12.0426 12.423 11.3324 11.6357 11.3324 10.6671C11.3324 9.69852 12.0206 8.90427 12.907 8.90427C13.7934 8.90427 14.4954 9.69852 14.4803 10.6671C14.4651 11.6357 13.7865 12.423 12.907 12.423Z" />
    </svg>
  )
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
    <DropdownMenuItem onSelect={() => openExternalUrl(url)}>
      {icon}
      {label}
      <ExternalLink className="ml-auto size-3 text-muted-foreground" />
    </DropdownMenuItem>
  )
}

export function SidebarSettingsHelpMenu(): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const setupProgress = useSetupGuideProgress(true, false, false)

  const settingsShortcut = useShortcutKeyDetails('app.settings')
  const [menuOpen, setMenuOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [showAdminOptions, setShowAdminOptions] = useState(false)
  const [isRestartingOrca, setIsRestartingOrca] = useState(false)
  const lastShowOnboardingAtRef = React.useRef(0)
  const mountedRef = useMountedRef()

  const showMilestones =
    setupProgress.ready && setupProgress.coreDoneCount < setupProgress.coreTotal

  const handleMenuOpenChange = (open: boolean): void => {
    setMenuOpen(open)
    if (!open) {
      setShowAdminOptions(false)
    }
  }

  const revealAdminOptions = (altKey: boolean): void => {
    // Why: onboarding replay and restart stay off the default Help menu; holding
    // Option/Alt before opening is an intentional power-user affordance.
    setShowAdminOptions(altKey)
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
    toast.info(
      translate('auto.components.sidebar.SidebarSettingsHelpMenu.5161eef55d', 'Restarting Orca…')
    )
    void window.api.app.restart().catch((error) => {
      if (mountedRef.current) {
        setIsRestartingOrca(false)
        toast.error(
          translate(
            'auto.components.sidebar.SidebarSettingsHelpMenu.4e8f5710d3',
            "Couldn't restart Orca."
          ),
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

  const handleCheckForUpdates = (event: Event): void => {
    const shiftKey = (event as PointerEvent).shiftKey
    void window.api.updater.check({ includePrerelease: shiftKey })
  }

  const openMilestones = (): void => {
    openModal('setup-guide', { telemetrySource: 'help_menu' })
  }

  return (
    <>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={translate(
                'auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998',
                'Settings'
              )}
              className="text-muted-foreground"
              onClick={openSettingsPage}
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className="flex items-center gap-1.5">
            {translate('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')}
            {settingsShortcut.keys.length > 0 ? (
              <ShortcutKeyCombo
                keys={settingsShortcut.keys}
                doubleTap={settingsShortcut.doubleTap}
                className="gap-0.5"
                keyCapClassName="min-w-0 border-background/20 bg-background/10 px-1 py-0 text-[10px] text-background shadow-none"
                separatorClassName="text-[10px] text-background/70"
              />
            ) : null}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleMenuOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  aria-label={translate(
                    'auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c',
                    'Help'
                  )}
                  className="text-muted-foreground"
                  onPointerDown={(event) => revealAdminOptions(event.altKey)}
                  onClick={(event) => revealAdminOptions(event.altKey)}
                >
                  <CircleHelp className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c', 'Help')}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-52">
            <DropdownMenuItem onSelect={openShortcutsSettings}>
              <Keyboard className="size-3.5" />
              {translate(
                'auto.components.sidebar.SidebarSettingsHelpMenu.e565171a7c',
                'Keyboard Shortcuts'
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setFeedbackOpen(true)}>
              <MessageSquareText className="size-3.5" />
              {translate(
                'auto.components.sidebar.SidebarSettingsHelpMenu.4cf5b868d7',
                'Send Feedback'
              )}
            </DropdownMenuItem>
            {showMilestones ? (
              <DropdownMenuItem onSelect={openMilestones}>
                <img
                  src={logo}
                  alt=""
                  aria-hidden="true"
                  className="size-3.5 object-contain invert opacity-55 dark:invert-0"
                />
                {translate(
                  'auto.components.sidebar.SidebarSettingsHelpMenu.f8a2c91d4e',
                  'Milestones'
                )}
                <SetupGuideProgressRing
                  done={setupProgress.coreDoneCount}
                  total={setupProgress.coreTotal}
                  sizeClassName="size-4"
                  className="ml-auto"
                />
              </DropdownMenuItem>
            ) : null}
            {showAdminOptions ? (
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={handleShowOnboarding}
                onSelect={handleShowOnboarding}
              >
                <School className="size-3.5" />
                {translate(
                  'auto.components.sidebar.SidebarSettingsHelpMenu.b7e4d2a19c',
                  'Onboarding'
                )}
              </DropdownMenuItem>
            ) : null}
            <ExternalMenuItem
              label={translate(
                'auto.components.sidebar.SidebarSettingsHelpMenu.cdc87f897e',
                'Docs'
              )}
              url={DOCS_URL}
              icon={<BookOpen className="size-3.5" />}
            />
            <ExternalMenuItem
              label={translate(
                'auto.components.sidebar.SidebarSettingsHelpMenu.5f83d86d92',
                'Changelog'
              )}
              url={CHANGELOG_URL}
              icon={<ScrollText className="size-3.5" />}
            />
            <DropdownMenuSeparator />
            <ExternalMenuItem
              label={translate(
                'auto.components.sidebar.SidebarSettingsHelpMenu.5687ab246a',
                'GitHub'
              )}
              url={GITHUB_URL}
              icon={<Github className="size-3.5" />}
            />
            <DropdownMenuItem onSelect={() => openExternalUrl(DISCORD_URL)}>
              <DiscordIcon />
              {translate('auto.components.sidebar.SidebarSettingsHelpMenu.eb9884e55b', 'Discord')}
              <ExternalLink className="ml-auto size-3 text-muted-foreground" />
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openExternalUrl(X_URL)}>
              <XIcon />
              {translate('auto.components.sidebar.SidebarSettingsHelpMenu.c4f8e1b72a', 'X')}
              <ExternalLink className="ml-auto size-3 text-muted-foreground" />
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
              onSelect={handleCheckForUpdates}
            >
              {updateStatus.state === 'checking' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {translate(
                'auto.components.sidebar.SidebarSettingsHelpMenu.29c56f30ee',
                'Check for Updates'
              )}
            </DropdownMenuItem>
            {showAdminOptions ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={handleRestartOrca} disabled={isRestartingOrca}>
                  <RotateCw className="size-3.5" />
                  {translate(
                    'auto.components.sidebar.SidebarSettingsHelpMenu.ad3d3ed7f1',
                    'Restart Orca'
                  )}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <SidebarFeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  )
}
