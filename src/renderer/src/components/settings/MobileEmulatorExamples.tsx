import { Copy, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

const EMULATOR_EXAMPLE_PROMPTS = [
  'Using Orca CLI, attach to the active iPhone simulator, sign in with the test account, complete onboarding, and tell me where the flow feels confusing.',
  'With Orca CLI, run through the mobile checkout flow from product search to confirmation, capture any broken screens, and summarize the exact step that fails.',
  'Using Orca CLI, grant camera permission, scan a test QR code or inject a camera fixture, finish the account-linking flow, and report whether the app reaches the success state.'
] as const

async function copyPrompt(prompt: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(prompt)
    toast.success(
      translate('auto.components.settings.MobileEmulatorExamples.2b077b5544', 'Copied prompt.')
    )
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.settings.MobileEmulatorExamples.1f608e7d60',
            'Failed to copy prompt.'
          )
    )
  }
}

type MobileEmulatorExamplesProps = {
  variant?: 'card' | 'inline'
}

export function MobileEmulatorExamples({
  variant = 'card'
}: MobileEmulatorExamplesProps): React.JSX.Element {
  return (
    <div
      className={cn(
        variant === 'card' ? 'rounded-xl border border-border/60 bg-card/50 p-4' : 'py-3'
      )}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-muted-foreground" />
        <p className="text-sm font-medium">
          {translate(
            'auto.components.settings.MobileEmulatorExamples.0820b3f84f',
            'Try it — example prompts'
          )}
        </p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.MobileEmulatorExamples.4daa95f25a',
          'Paste any of these into Claude Code, Codex, or another agent in a project where the Orca CLI skill is installed.'
        )}
      </p>
      <ul className="mt-3 space-y-2">
        {EMULATOR_EXAMPLE_PROMPTS.map((prompt) => (
          <li
            key={prompt}
            className="flex items-start gap-2 rounded-lg border border-border bg-background px-3 py-2"
          >
            <p className="flex-1 text-[11px] leading-relaxed text-foreground/90">
              {translate('auto.components.settings.MobileEmulatorExamples.b525ff2b12', '"')}
              {prompt}
              {translate('auto.components.settings.MobileEmulatorExamples.d151e25078', '"')}
            </p>
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate(
                      'auto.components.settings.MobileEmulatorExamples.c12b253997',
                      'Copy example prompt'
                    )}
                    onClick={() => void copyPrompt(prompt)}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={6}>
                  {translate('auto.components.settings.MobileEmulatorExamples.edf13dd03b', 'Copy')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </li>
        ))}
      </ul>
    </div>
  )
}
