import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

type FullDiskAccessNudgeToastProps = {
  promptCount: number
  onEnable: () => void
  onClose: () => void
  onDontShowAgain: () => void
}

function StackedPromptsIllustration({ promptCount }: { promptCount: number }): React.JSX.Element {
  return (
    <div className="relative h-[58px] w-[74px] shrink-0" aria-hidden="true">
      <div className="absolute top-[2px] left-[10px] h-[40px] w-[56px] -rotate-6 rounded-[6px] border border-border bg-muted opacity-40" />
      <div className="absolute top-[7px] left-[6px] h-[40px] w-[56px] rotate-3 rounded-[6px] border border-border bg-muted opacity-70" />
      <div className="absolute top-[13px] left-[2px] flex h-[42px] w-[58px] flex-col gap-[5px] rounded-[6px] border border-border bg-background px-[7px] pt-[8px] shadow-xs">
        <span className="h-[3px] w-[34px] rounded-full bg-muted-foreground/50" />
        <span className="h-[3px] w-[24px] rounded-full bg-muted-foreground/35" />
        <span className="absolute right-[5px] bottom-[5px] h-[9px] w-[20px] rounded-full bg-callout-note" />
      </div>
      <span className="absolute -top-[2px] -right-[4px] min-w-[20px] rounded-full bg-status-warning px-[6px] py-px text-center text-[10.5px] leading-[15px] font-bold text-black">
        {promptCount}
      </span>
    </div>
  )
}

export function FullDiskAccessNudgeToast({
  promptCount,
  onEnable,
  onClose,
  onDontShowAgain
}: FullDiskAccessNudgeToastProps): React.JSX.Element {
  const t = useTranslate()
  const title =
    promptCount > 1
      ? t('auto.hooks.useMacosTccPromptNotice.titleMany', 'macOS showed {{count}} file prompts', {
          count: promptCount
        })
      : t('auto.hooks.useMacosTccPromptNotice.titleOne', 'macOS just showed a file prompt')

  return (
    <div className="@container relative w-[26rem] max-w-full rounded-lg border border-border bg-popover px-3.5 py-3.5 text-popover-foreground shadow-floating">
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 size-7"
        data-close-button
        onClick={onClose}
        aria-label={t('auto.hooks.useMacosTccPromptNotice.close', 'Close')}
      >
        <X className="size-3.5" />
      </Button>
      <div className="flex items-center gap-4">
        <StackedPromptsIllustration promptCount={promptCount} />
        <div className="min-w-0 space-y-1 pr-6">
          <div className="text-[13.5px] leading-snug font-semibold">{title}</div>
          <p className="text-[12.5px] leading-snug text-muted-foreground">
            {t(
              'auto.hooks.useMacosTccPromptNotice.subtitle',
              'Full Disk Access stops these prompts.'
            )}
          </p>
        </div>
      </div>
      {/* Why: on a roomy card, indent by illustration width + gap so the actions start
          under the title. Below ~22rem of card width (20rem content box) that indent would
          push the button past the border, so the row drops it and stacks full width. */}
      <div className="mt-3 flex flex-col items-start gap-y-1.5 @[20rem]:ml-[90px] @[20rem]:flex-row @[20rem]:flex-wrap @[20rem]:items-center @[20rem]:gap-x-2">
        {/* Why: Button is nowrap/shrink-0 by default; let the label wrap rather than overflow. */}
        <Button
          variant="default"
          size="sm"
          className="h-auto min-h-8 max-w-full whitespace-normal"
          onClick={onEnable}
        >
          {t('auto.hooks.useMacosTccPromptNotice.enable', 'Turn on Full Disk Access')}
        </Button>
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={onDontShowAgain}
        >
          {t('auto.hooks.useMacosTccPromptNotice.dismiss', "Don't show again")}
        </button>
      </div>
    </div>
  )
}
