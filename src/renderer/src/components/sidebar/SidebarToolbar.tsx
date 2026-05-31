import React, { useState } from 'react'
import {
  BookOpen,
  Boxes,
  CircleHelp,
  ExternalLink,
  FolderPlus,
  HardDrive,
  MessageSquareText,
  RotateCw,
  School,
  Settings,
  Smartphone
} from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { showOnboardingFromRenderer } from '../onboarding/show-onboarding-event'
import { SidebarFeedbackDialog } from './SidebarFeedbackDialog'
import { ScrollToCurrentWorkspaceToolbarButton } from './ScrollToCurrentWorkspaceToolbarButton'

const DOCS_URL = 'https://www.onorca.dev/docs'

function openExternalUrl(url: string): void {
  void window.api.shell.openUrl(url)
}

const SidebarToolbar = React.memo(function SidebarToolbar() {
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSkillsPage = useAppStore((s) => s.openSkillsPage)
  const openSpacePage = useAppStore((s) => s.openSpacePage)
  const openMobilePage = useAppStore((s) => s.openMobilePage)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [helpMenuOpen, setHelpMenuOpen] = useState(false)
  const [showAdminHelpOptions, setShowAdminHelpOptions] = useState(false)
  const [isRestartingOrca, setIsRestartingOrca] = useState(false)
  const lastShowOnboardingAtRef = React.useRef(0)
  const mountedRef = useMountedRef()

  const handleShowOnboarding = (): void => {
    const now = Date.now()
    if (now - lastShowOnboardingAtRef.current < 500) {
      return
    }
    lastShowOnboardingAtRef.current = now
    void showOnboardingFromRenderer()
  }

  const handleHelpMenuOpenChange = (open: boolean): void => {
    setHelpMenuOpen(open)
    if (!open) {
      setShowAdminHelpOptions(false)
    }
  }

  const revealAdminHelpOptions = (altKey: boolean): void => {
    // Why: keep restart off the ordinary Help menu; Alt/Option-click is an
    // intentional admin affordance for recovering the app without teaching it
    // as a normal user workflow.
    setShowAdminHelpOptions(altKey)
  }

  const handleRestartOrca = (): void => {
    if (isRestartingOrca) {
      return
    }
    setIsRestartingOrca(true)
    toast.info('Restarting Orca…')
    void window.api.app.restart().catch((error) => {
      if (mountedRef.current) {
        setIsRestartingOrca(false)
        toast.error('Couldn’t restart Orca.', {
          description: error instanceof Error ? error.message : undefined
        })
      }
    })
  }

  return (
    <div className="mt-auto shrink-0">
      <div className="flex items-center justify-between border-t border-sidebar-border px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => openModal('add-repo')}
              className="gap-1.5 text-muted-foreground"
            >
              <FolderPlus className="size-3.5" />
              <span className="text-[11px]">Add Project</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Open folder picker to add a project
          </TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-1">
          <ScrollToCurrentWorkspaceToolbarButton />
          <DropdownMenu modal={false}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    aria-label="Toolbox"
                    className="text-muted-foreground"
                  >
                    <Boxes className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                Toolbox
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-44">
              <DropdownMenuItem onSelect={openSkillsPage}>
                <BookOpen className="size-3.5" />
                Skills
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openSpacePage}>
                <HardDrive className="size-3.5" />
                Space Analyzer
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openMobilePage}>
                <Smartphone className="size-3.5" />
                Orca Mobile
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu modal={false} open={helpMenuOpen} onOpenChange={handleHelpMenuOpenChange}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    aria-label="Help"
                    className="text-muted-foreground"
                    onPointerDown={(event) => revealAdminHelpOptions(event.altKey)}
                    onClick={(event) => revealAdminHelpOptions(event.altKey)}
                  >
                    <CircleHelp className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                Help
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-48">
              <DropdownMenuItem
                className="whitespace-nowrap"
                onClick={handleShowOnboarding}
                onSelect={handleShowOnboarding}
              >
                <School className="size-3.5" />
                Show Onboarding
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setFeedbackOpen(true)}>
                <MessageSquareText className="size-3.5" />
                Send feedback
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openExternalUrl(DOCS_URL)}>
                <ExternalLink className="size-3.5" />
                Docs
              </DropdownMenuItem>
              {showAdminHelpOptions ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={handleRestartOrca} disabled={isRestartingOrca}>
                    <RotateCw className="size-3.5" />
                    Restart Orca
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={openSettingsPage}
                className="text-muted-foreground"
              >
                <Settings className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Settings
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <SidebarFeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </div>
  )
})

export default SidebarToolbar
