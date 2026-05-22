import { useEffect, useState, type JSX } from 'react'
import { Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { ORCA_CLI_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import { Button } from '@/components/ui/button'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'

// Why: matches the slide-in duration in OnboardingInlineCommandTerminal so
// the trigger button only fades after the terminal has finished revealing.
const TERMINAL_REVEAL_MS = 700

export function OrcaCliSkillSetupCard(props: {
  compact?: boolean
  terminalHeightPx?: number
}): JSX.Element {
  const { compact, terminalHeightPx } = props
  const [showTerminal, setShowTerminal] = useState(false)
  const [buttonVisible, setButtonVisible] = useState(true)

  useEffect(() => {
    if (!showTerminal) {
      setButtonVisible(true)
      return
    }
    const timer = window.setTimeout(() => setButtonVisible(false), TERMINAL_REVEAL_MS)
    return () => window.clearTimeout(timer)
  }, [showTerminal])

  // Why: matches the onboarding flow (runOnboardingFeatureSetup) — registering
  // the `orca` CLI is a prerequisite for the skill, so we do it implicitly when
  // the user opts into setup. Failures surface as a toast but don't block the
  // terminal, since the user may already have it installed via another path.
  const handleInstall = async (): Promise<void> => {
    try {
      const status = await window.api.cli.getInstallStatus()
      if (status.supported && status.state !== 'installed') {
        await window.api.cli.install()
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to register the orca CLI in PATH.'
      )
    }
    localStorage.setItem(BROWSER_USE_ENABLED_STORAGE_KEY, '1')
    setShowTerminal(true)
  }

  const button = (
    <Button variant="default" size="sm" onClick={() => void handleInstall()}>
      <Terminal aria-hidden />
      Install the skill
    </Button>
  )

  const terminal = showTerminal ? (
    <OnboardingInlineCommandTerminal
      command={ORCA_CLI_SKILL_INSTALL_COMMAND}
      title="Orca CLI setup"
      ariaLabel="Orca CLI skill install command"
      description="Press Enter to install the Orca CLI skill. Confirm npx if asked."
      terminalHeightPx={terminalHeightPx}
    />
  ) : null

  if (compact) {
    return (
      <div className="relative flex min-h-24 flex-1 items-center justify-center pt-3">
        <div
          aria-hidden={!buttonVisible}
          className={`transition-opacity duration-300 ${
            buttonVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        >
          {button}
        </div>
        {terminal ? (
          <div className="pointer-events-auto absolute inset-x-0 top-1/2 z-10 -translate-y-1/2">
            {terminal}
          </div>
        ) : null}
      </div>
    )
  }
  if (terminal) {
    return terminal
  }
  return <div className="flex">{button}</div>
}
