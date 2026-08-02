import { Fragment } from 'react'
import { Copy, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { SkillUsageExample } from '@/lib/skill-usage-example'
import { translate } from '@/i18n/i18n'

function SkillUsageExamplePromptText(props: {
  prompt: string
  slashCommand: string
}): React.JSX.Element {
  const { prompt, slashCommand } = props
  const parts = prompt.split(slashCommand)

  if (parts.length === 1) {
    return <>{prompt}</>
  }

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? (
            <span className="font-semibold text-foreground">{slashCommand}</span>
          ) : null}
        </Fragment>
      ))}
    </>
  )
}

export function SkillUsageExampleDialog(props: {
  example: SkillUsageExample
  // Why: the copyable prompt highlights the skill's slash command so the reader
  // sees which skill to invoke; each skill passes its own (e.g. /orchestration).
  slashCommand: string
  icon?: LucideIcon
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { example, slashCommand, icon: Icon, open, onOpenChange } = props

  const copyPrompt = async (prompt: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(prompt)
      toast.success(
        translate(
          'auto.components.settings.SkillUsageExampleDialog.copiedPrompt',
          'Copied example prompt.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.SkillUsageExampleDialog.copyFailed',
              'Failed to copy prompt.'
            )
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <div className="px-6 pt-6 pr-14">
          <DialogHeader className="gap-3">
            <div className="flex items-start gap-3">
              {Icon ? (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground">
                  <Icon className="size-4" />
                </div>
              ) : null}
              <div className="min-w-0 space-y-1.5">
                <DialogTitle className="text-base leading-snug">{example.title}</DialogTitle>
                <DialogDescription className="text-xs leading-relaxed">
                  {example.summary}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="px-6 py-5">
          <div className="group relative rounded-md border border-border/70 bg-editor-surface shadow-xs">
            <p className="px-3 py-3 pr-11 font-mono text-[12px] leading-relaxed text-foreground">
              <SkillUsageExamplePromptText prompt={example.prompt} slashCommand={slashCommand} />
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute top-2 right-2 shrink-0 opacity-70 transition-opacity group-hover:opacity-100"
              aria-label={translate(
                'auto.components.settings.SkillUsageExampleDialog.copyExampleAria',
                'Copy {{value0}} example prompt',
                { value0: example.title }
              )}
              onClick={() => void copyPrompt(example.prompt)}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        </div>

        <DialogFooter className="gap-2 border-t border-border/60 bg-muted/10 px-6 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.SkillUsageExampleDialog.done', 'Done')}
          </Button>
          <Button type="button" size="sm" onClick={() => void copyPrompt(example.prompt)}>
            <Copy className="size-4" />
            {translate(
              'auto.components.settings.SkillUsageExampleDialog.copyPrompt',
              'Copy prompt'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
