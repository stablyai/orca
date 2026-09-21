import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildSkillSetupTerminalCommand } from '../settings/CliSkillRuntimeSetup'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'
import type { AntigravityInstallTarget } from './antigravity-install-target'

export function AntigravityInstallDialog({
  target,
  onClose
}: {
  target: AntigravityInstallTarget
  onClose: () => void
}): React.JSX.Element {
  const prepareCommand = useCallback(
    (command: string, shell: string | undefined) =>
      buildSkillSetupTerminalCommand(command, shell, target.runtime, target.platform),
    [target]
  )
  const refreshAgents = useAppStore((state) => state.refreshDetectedAgents)
  const detected = useAppStore((state) => state.detectedAgentIds?.includes('antigravity') === true)
  const isRefreshing = useAppStore((state) => state.isRefreshingAgents)
  return (
    <Dialog open>
      <DialogContent
        className="z-[120] sm:max-w-3xl"
        overlayClassName="z-[110]"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('components.onboarding.agyInstall.title', 'Install Antigravity')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'components.onboarding.agyInstall.description',
              'Press Enter in the terminal to run the official installer. Closing this terminal stops any command still running.'
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {translate('components.onboarding.agyInstall.target', 'Install location: {{location}}', {
            location:
              target.runtime.label ||
              translate('components.onboarding.agyInstall.thisDevice', 'This device')
          })}
        </p>
        <OnboardingInlineCommandTerminal
          command={target.command}
          prepareCommandForShell={prepareCommand}
          shellOverride={target.shellOverride}
          forceHostRuntime
          title={translate('components.onboarding.agyInstall.terminal', 'Antigravity installer')}
          ariaLabel={translate(
            'components.onboarding.agyInstall.terminal',
            'Antigravity installer'
          )}
          worktreeId="onboarding-antigravity-install"
          terminalTopMarginPx={0}
          autoScrollIntoView={false}
        />
        {detected && (
          <p role="status" className="text-sm text-foreground">
            {translate(
              'components.onboarding.agyInstall.detected',
              'Antigravity is detected on PATH. Close the terminal when the installer has finished.'
            )}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {translate('components.onboarding.agyInstall.close', 'Close terminal')}
          </Button>
          <Button disabled={isRefreshing} onClick={() => void refreshAgents()}>
            {translate('components.onboarding.agyInstall.recheck', 'Re-check agents')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
