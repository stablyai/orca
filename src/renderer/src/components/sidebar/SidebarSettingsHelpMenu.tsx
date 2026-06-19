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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 fill-current">
      <path d="M20.317 4.369A19.791 19.791 0 0 0 15.885 3c-.191.328-.403.77-.553 1.116a18.27 18.27 0 0 0-5.098 0A12.64 12.64 0 0 0 9.68 3a19.736 19.736 0 0 0-4.433 1.369C2.444 8.479 1.69 12.488 2.067 16.44a19.912 19.912 0 0 0 5.427 2.744c.438-.598.828-1.23 1.164-1.89a12.95 12.95 0 0 1-1.833-.877c.154-.113.305-.231.45-.352a14.294 14.294 0 0 0 12.45 0c.146.12.296.239.45.352-.585.34-1.2.634-1.835.878.337.659.727 1.29 1.165 1.888a19.84 19.84 0 0 0 5.43-2.744c.442-4.579-.755-8.551-3.932-12.07ZM9.955 14.005c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.211 0 2.176 1.095 2.157 2.418 0 1.334-.955 2.419-2.157 2.419Zm4.09 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.211 0 2.176 1.095 2.157 2.418 0 1.334-.946 2.419-2.157 2.419Z" />
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
