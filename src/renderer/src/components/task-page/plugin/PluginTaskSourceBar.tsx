import type React from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { ActivePluginTaskSource } from '@/store/plugin-task-sources'
import { TaskPageSourceIconButton } from '../SourceIconButton'
import { TaskPagePluginSourceButtons } from './PluginSourceButtons'
import { useVisibleBuiltinTaskSourceOptions } from './use-builtin-task-source-options'

/** Source bar while a plugin source is open: same close button and tabs as the built-in bar. */
export function PluginTaskSourceBar({
  source
}: {
  source: ActivePluginTaskSource
}): React.JSX.Element {
  const closeTaskPage = useAppStore((state) => state.closeTaskPage)
  const openTaskPage = useAppStore((state) => state.openTaskPage)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const builtinOptions = useVisibleBuiltinTaskSourceOptions()
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-full"
            onClick={closeTaskPage}
            aria-label={translate('auto.components.TaskPage.1a06219d5c', 'Close tasks')}
          >
            <X className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.TaskPage.4826fd1ad8', 'Close · Esc')}
        </TooltipContent>
      </Tooltip>
      <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
      {builtinOptions.map((option) => (
        <TaskPageSourceIconButton
          key={option.id}
          label={option.label}
          active={false}
          dataTaskSource={option.id}
          onSelect={() => {
            openTaskPage({ taskSource: option.id }, { recordTasksInteraction: false })
            void updateSettings({
              defaultTaskSource: option.id,
              defaultPluginTaskSource: null
            }).catch(() => {
              toast.error(
                translate(
                  'auto.components.TaskPage.609532fae7',
                  'Failed to save default task source.'
                )
              )
            })
          }}
        >
          <option.Icon className="size-3.5" />
        </TaskPageSourceIconButton>
      ))}
      <TaskPagePluginSourceButtons activeKey={source.key} />
      <div
        className="hidden min-w-0 max-w-[min(420px,40vw)] items-center rounded-md border border-border/50 bg-muted/35 px-2 py-1 text-xs text-muted-foreground sm:flex"
        title={source.pluginName}
      >
        <span className="truncate">
          {translate('auto.components.TaskPage.pluginTaskSourceContext', '{{value0}} · plugin', {
            value0: source.title
          })}
        </span>
      </div>
    </div>
  )
}
