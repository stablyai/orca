import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { MobileEmulatorAgentSetupGuideSteps } from './MobileEmulatorAgentSetupGuideSteps'
import type { useMobileEmulatorAgentSetupState } from './use-mobile-emulator-agent-setup-state'
import { translate } from '@/i18n/i18n'

type MobileEmulatorAgentSetupGuideProps = {
  setup: ReturnType<typeof useMobileEmulatorAgentSetupState>
  worktreeId: string
}

export function MobileEmulatorAgentSetupGuide({
  setup,
  worktreeId
}: MobileEmulatorAgentSetupGuideProps): React.JSX.Element {
  const dismissMobileEmulatorAgentSetup = useAppStore((s) => s.dismissMobileEmulatorAgentSetup)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [expanded, setExpanded] = useState(false)

  const dismiss = (): void => {
    dismissMobileEmulatorAgentSetup()
  }

  const openSettings = (): void => {
    recordFeatureInteraction('mobile-emulator-agent-setup')
    openSettingsTarget({ pane: 'mobile-emulator', repoId: null })
    openSettingsPage()
  }

  return (
    <div
      role="region"
      aria-label={translate(
        'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.2fda9ff015',
        'Set up agent control'
      )}
      className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <p className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">
          {setup.setupComplete ? (
            <span className="font-medium text-foreground">
              {translate(
                'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.0ac0fef514',
                'Agent control is ready.'
              )}
            </span>
          ) : (
            <>
              <span className="font-medium text-foreground">
                {translate(
                  'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.2bdfff8763',
                  'Agent control (optional).'
                )}{' '}
              </span>
              {translate(
                'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.72736b051f',
                'Set up Orca CLI + skill when you want agents to drive this simulator.'
              )}
            </>
          )}
        </p>

        <div className="flex shrink-0 items-center gap-1 self-center">
          {setup.setupComplete ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-6 px-2.5 text-[11px]"
              onClick={dismiss}
            >
              {translate(
                'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.d10ae98046',
                'Done'
              )}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px] text-muted-foreground"
                onClick={dismiss}
              >
                {translate(
                  'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.3756cbeca7',
                  'Not now'
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={expanded ? 'secondary' : 'default'}
                className="h-6 gap-1 px-2 text-[11px]"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded
                  ? translate(
                      'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.6d950431d2',
                      'Hide'
                    )
                  : translate(
                      'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.ebceac65a4',
                      'Set up'
                    )}
                {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              </Button>
            </>
          )}
        </div>
      </div>

      {expanded && !setup.setupComplete ? (
        <div className="scrollbar-sleek max-h-[min(36vh,16rem)] overflow-y-auto border-t border-border/60 px-3 pb-2">
          <div className="flex items-center justify-end py-1.5">
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                setup.setupComplete
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {setup.completedCount}/2
            </span>
          </div>
          <MobileEmulatorAgentSetupGuideSteps setup={setup} worktreeId={worktreeId} />
          <div className="pb-1 pt-1">
            <button
              type="button"
              onClick={openSettings}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {translate(
                'auto.components.emulator.pane.MobileEmulatorAgentSetupGuide.3f003507f4',
                'Open full setup in Settings'
              )}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
