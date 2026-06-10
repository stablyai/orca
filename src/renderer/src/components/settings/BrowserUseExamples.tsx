import { Copy, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

const EXAMPLE_PROMPTS: string[] = [
  'Using Orca CLI, open https://github.com/notifications and click the first unread pull request.',
  "Take a screenshot of my open Linear board with the Orca CLI and tell me what's blocked.",
  'With Orca CLI, go to our staging app, log in (my cookies are imported), and verify the checkout flow works.'
]

async function handleCopyText(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.settings.BrowserUseExamples.a602d43069', 'Copied {{value0}}.', {
        value0: label
      })
    )
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate('auto.components.settings.BrowserUseExamples.5ec620ccc4', 'Failed to copy.')
    )
  }
}

export function BrowserUseExamples(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-muted-foreground" />
        <p className="text-sm font-medium">
          {translate(
            'auto.components.settings.BrowserUseExamples.2a180694f7',
            'Try it — example prompts'
          )}
        </p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.BrowserUseExamples.c5325e91f6',
          'Paste any of these into Claude Code, Codex, or another agent in a project where the skill is installed.'
        )}
      </p>
      <ul className="mt-3 space-y-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <li
            key={prompt}
            className="flex items-start gap-2 rounded-lg border border-border/50 bg-background/60 px-3 py-2"
          >
            <p className="flex-1 text-[11px] leading-relaxed text-foreground/90">
              {translate('auto.components.settings.BrowserUseExamples.59722f31b4', '"')}
              {prompt}
              {translate('auto.components.settings.BrowserUseExamples.b84807f228', '"')}
            </p>
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void handleCopyText(prompt, 'prompt')}
                    aria-label={translate(
                      'auto.components.settings.BrowserUseExamples.1188e56af4',
                      'Copy example prompt'
                    )}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={6}>
                  {translate('auto.components.settings.BrowserUseExamples.1199258ace', 'Copy')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </li>
        ))}
      </ul>
    </div>
  )
}
