import React, { useEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SidebarViewToggle } from './sidebar-view-toggle'
import { SidebarHeaderActions } from './sidebar-header-actions'
import { shouldShowAgentsSidebar } from './agents-sidebar-visibility'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'

type SidebarHeaderProps = {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  agentToolbar?: React.ReactNode
  agentSearchRow?: React.ReactNode
  showAgentsSidebar?: boolean
}

const SidebarHeader = React.memo(function SidebarHeader({
  onWorkspaceBoardMenuOpenChange,
  agentToolbar,
  agentSearchRow,
  showAgentsSidebar: showAgentsSidebarProp
}: SidebarHeaderProps) {
  // Subscribe this memoized header to locale changes before using translate().
  useTranslation()
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'workspaces')
  // Why the derived boolean, not s.settings: the settings object gets a new identity on
  // every write, which would re-render this memoized header subtree each time.
  const showAgentsSidebarFromStore = useAppStore((s) => shouldShowAgentsSidebar(s.settings))
  const showAgentsSidebar = showAgentsSidebarProp ?? showAgentsSidebarFromStore
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const agentsSidebarIntroShown = useAppStore((s) => s.settings?.agentsSidebarIntroShown === true)
  const migratedFromExperimental = useAppStore(
    (s) => s.settings?.agentsSidebarMigratedFromExperimental === true
  )
  const introTitleId = useId()
  const introDescriptionId = useId()
  // Why: settings are null until hydration; deriving intro visibility from the
  // null default would flash the popover open (and stamp it shown) every launch.
  const settingsHydrated = useAppStore((s) => s.settings != null)
  const agentsViewActive = showAgentsSidebar && sidebarBody === 'agents'
  const introOpen = settingsHydrated && showAgentsSidebar && !agentsSidebarIntroShown
  const acknowledgeIntro = React.useCallback(() => {
    void updateSettings?.({ agentsSidebarIntroShown: true })
  }, [updateSettings])
  const deferAgentsIntro = React.useCallback(() => {
    // Hide the new tab; users can re-enable it in Settings.
    void updateSettings?.({ agentsSidebarIntroShown: true, showAgentsSidebar: false })
    toast(
      translate(
        'agentsSidebarIntro.new.hiddenToast',
        'Agents tab hidden. Re-enable it in Settings → Experimental.'
      )
    )
  }, [updateSettings])

  useEffect(() => {
    // Wait for hydration: settings null must not clobber a persisted 'agents' body.
    if (settingsHydrated && !showAgentsSidebar && sidebarBody === 'agents') {
      setSidebarBody?.('workspaces')
    }
  }, [setSidebarBody, settingsHydrated, showAgentsSidebar, sidebarBody])

  return (
    <>
      <div className="mt-2 flex h-9 min-w-0 items-center justify-between gap-1.5 px-2">
        <Popover
          open={introOpen}
          onOpenChange={(open) => {
            if (!open) {
              acknowledgeIntro()
            }
          }}
        >
          <div className="flex h-9 items-center">
            <SidebarViewToggle
              ariaLabel={translate('auto.components.sidebar.SidebarHeader.views', 'Sidebar view')}
              value={agentsViewActive ? 'agents' : 'workspaces'}
              onSelect={(value) => {
                // Only stamp the intro as seen when it is actually on screen.
                if (introOpen) {
                  acknowledgeIntro()
                }
                setSidebarBody?.(value as 'workspaces' | 'agents')
              }}
              options={[
                {
                  value: 'workspaces',
                  label: translate('auto.components.sidebar.SidebarHeader.spaces', 'Spaces'),
                  sectionTitle: 'projects'
                },
                ...(showAgentsSidebar
                  ? [
                      {
                        value: 'agents' as const,
                        label: translate('dashboard.sidebar.label', 'Agents'),
                        sectionTitle: 'agents' as const,
                        renderWrapper: (button: React.ReactNode) => (
                          <PopoverAnchor asChild>{button}</PopoverAnchor>
                        )
                      }
                    ]
                  : [])
              ]}
            />
          </div>
          {/* Why: prevent startup terminal/editor auto-focus from dismissing the intro popover. */}
          <PopoverContent
            side="bottom"
            align="center"
            sideOffset={8}
            className="w-72 overflow-visible rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-floating"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onFocusOutside={(event) => event.preventDefault()}
            aria-labelledby={introTitleId}
            aria-describedby={introDescriptionId}
          >
            <PopoverArrow asChild width={14} height={7} className="overflow-visible">
              <svg
                viewBox="0 0 30 10"
                preserveAspectRatio="none"
                className="block overflow-visible"
              >
                <polygon points="0,0 30,0 15,10" className="fill-popover" />
                <path d="M0 0 L15 10 L30 0" fill="none" className="stroke-border stroke-[1.5]" />
              </svg>
            </PopoverArrow>
            <div className="space-y-2.5">
              <svg width="0" height="0" className="absolute pointer-events-none" aria-hidden="true">
                <defs>
                  <linearGradient id="agents-intro-aquatic" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#10b981" />
                    <stop offset="45%" stopColor="#06b6d4" />
                    <stop offset="100%" stopColor="#2563eb" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Sparkles
                    className="size-4 shrink-0"
                    stroke="url(#agents-intro-aquatic)"
                    fill="url(#agents-intro-aquatic)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                  <h3 id={introTitleId} className="text-sm font-semibold text-foreground">
                    {migratedFromExperimental
                      ? translate('agentsSidebarIntro.migrated.title', 'Agents are easier to find')
                      : translate('agentsSidebarIntro.new.title', 'Meet your Agents tab')}
                  </h3>
                </div>
                <p
                  id={introDescriptionId}
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  {migratedFromExperimental
                    ? translate(
                        'agentsSidebarIntro.migrated.description',
                        'Your Agents view is now a dedicated sidebar tab. Your activity and filters are preserved.'
                      )
                    : translate(
                        'agentsSidebarIntro.new.description',
                        'See what your agents are working on, what is done, and where you need to step in.'
                      )}
                </p>
              </div>
              <div className="flex justify-end items-center gap-2 pt-0.5">
                {!migratedFromExperimental ? (
                  <Button variant="ghost" size="sm" onClick={deferAgentsIntro}>
                    {translate('agentsSidebarIntro.new.hide', 'Hide Agents')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  className="border-0 bg-[linear-gradient(135deg,#10b981_0%,#06b6d4_45%,#2563eb_100%)] text-white font-medium shadow-xs hover:brightness-105 active:scale-[0.98] transition-all"
                  onClick={() => {
                    acknowledgeIntro()
                    setSidebarBody?.('agents')
                  }}
                >
                  {migratedFromExperimental
                    ? translate('agentsSidebarIntro.migrated.action', 'Open Agents')
                    : translate('agentsSidebarIntro.new.action', 'Try Agents')}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        {agentsViewActive ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Do not add an expand action: the full Agents view is deprecated and must not open. */}
            {agentToolbar}
          </div>
        ) : null}
        {!agentsViewActive ? (
          <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={onWorkspaceBoardMenuOpenChange} />
        ) : null}
      </div>
      {agentsViewActive ? agentSearchRow : null}
    </>
  )
})

export default SidebarHeader
