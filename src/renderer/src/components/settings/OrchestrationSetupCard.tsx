import { useEffect, useState, type JSX } from 'react'
import { Terminal } from 'lucide-react'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import { Button } from '@/components/ui/button'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'

// Matches the slide-in duration in OnboardingInlineCommandTerminal so the
// button only fades after the terminal has finished revealing.
const TERMINAL_REVEAL_MS = 700

export function OrchestrationSetupCard(props: {
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

  const button = (
    <Button variant="default" size="sm" onClick={() => setShowTerminal(true)}>
      <Terminal aria-hidden />
      Install the skill
    </Button>
  )

  const terminal = showTerminal ? (
    <OnboardingInlineCommandTerminal
      command={ORCHESTRATION_SKILL_INSTALL_COMMAND}
      title="Orchestration setup"
      ariaLabel="Orchestration skill install command"
      description="Press Enter to install the orchestration skill. Confirm npx if asked."
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
          // Why: absolute-positioned overlay so the terminal grows over the
          // button instead of pushing the feature wall layout around.
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
