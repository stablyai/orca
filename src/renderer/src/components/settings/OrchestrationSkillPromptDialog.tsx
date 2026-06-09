import { Copy } from 'lucide-react'
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
import { translate } from '@/i18n/i18n'

export function OrchestrationSkillPromptDialog(props: {
  command: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { command, open, onOpenChange } = props

  const copyCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(command)
      toast.success(translate("auto.components.settings.OrchestrationSkillPromptDialog.239bf9132b", "Copied install command."))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : translate("auto.components.settings.OrchestrationSkillPromptDialog.d3dc559225", "Failed to copy install command."))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <div className="px-6 pt-6 pr-14">
          <DialogHeader className="gap-2">
            <DialogTitle className="text-base leading-snug">
              {translate("auto.components.settings.OrchestrationSkillPromptDialog.2914abcfa2", "Install orchestration skill")}</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {translate("auto.components.settings.OrchestrationSkillPromptDialog.b99f375eb2", "Run this command in a terminal to install the orchestration skill for your agents.")}</DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-6 py-5">
          <div className="group relative rounded-md border border-border/70 bg-editor-surface shadow-xs">
            <p className="px-3 py-3 pr-11 font-mono text-[12px] leading-relaxed break-all text-foreground">
              {command}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute top-2 right-2 shrink-0 opacity-70 transition-opacity group-hover:opacity-100"
              aria-label={translate("auto.components.settings.OrchestrationSkillPromptDialog.1bdce1911e", "Copy orchestration skill install command")}
              onClick={() => void copyCommand()}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        </div>

        <DialogFooter className="gap-2 border-t border-border/60 bg-muted/10 px-6 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {translate("auto.components.settings.OrchestrationSkillPromptDialog.35550f3b3b", "Done")}</Button>
          <Button type="button" size="sm" onClick={() => void copyCommand()}>
            <Copy className="size-4" />
            {translate("auto.components.settings.OrchestrationSkillPromptDialog.f08d45293d", "Copy command")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
