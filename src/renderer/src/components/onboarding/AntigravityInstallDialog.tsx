// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
import { useCallback, useState } from 'react'
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
import { buildSkillSetupTerminalCommand } from '@/lib/skill-runtime-command'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'
import {
  ANTIGRAVITY_INSTALL_TERMINAL_WORKTREE_ID,
  type AntigravityInstallTarget
} from './antigravity-install-target'

/** Blocks onboarding navigation while open, so leaving the step can't close a running installer. */
export function AntigravityInstallDialog({
  target,
  detected,
  onRecheck,
  onClose
}: {
  target: AntigravityInstallTarget
  detected: boolean
  onRecheck: () => Promise<unknown>
  onClose: () => void
}): React.JSX.Element {
  const [rechecking, setRechecking] = useState(false)
  const prepareCommand = useCallback(
    (command: string, shell: string | undefined) =>
      buildSkillSetupTerminalCommand(command, shell, target.runtime, target.platform),
    [target]
  )
  const recheck = useCallback(() => {
    setRechecking(true)
    void onRecheck().finally(() => setRechecking(false))
  }, [onRecheck])
  const terminalLabel = translate(
    'components.onboarding.agyInstall.terminal',
    'Antigravity installer'
  )
  return (
    <Dialog open>
      <DialogContent
        className="z-[120] sm:max-w-3xl"
        overlayClassName="z-[110]"
        showCloseButton={false}
        // Focus lands in the terminal once it's ready, so an early Enter can't hit Close.
        onOpenAutoFocus={(event) => event.preventDefault()}
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
          title={terminalLabel}
          ariaLabel={terminalLabel}
          worktreeId={ANTIGRAVITY_INSTALL_TERMINAL_WORKTREE_ID}
          terminalTopMarginPx={0}
          autoScrollIntoView={false}
          onCommandFinished={recheck}
          onTerminalExit={onClose}
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
          <Button disabled={rechecking} onClick={recheck}>
            {translate('components.onboarding.agyInstall.recheck', 'Re-check agents')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
