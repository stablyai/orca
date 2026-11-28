import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PluginDeclarativeIconGlyph } from '@/components/plugins/declarative/plugin-declarative-icons'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatPluginComposerItem as ComposerItem } from './use-native-chat-plugin-composer-items'

export function NativeChatPluginComposerItem({
  item,
  onInvoke
}: {
  item: ComposerItem
  onInvoke?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const tooltip = item.tooltip || item.pluginName
  const { command, popover, running } = item
  const showPopover = popover && (popover.title || popover.rows?.length || popover.actions?.length)

  const run = (id: string): Promise<void> =>
    item.runCommand(id).catch(() => {
      toast.error(t('auto.App.pluginCommandFailed', 'Could not run the plugin command.'))
    })

  const content = (
    <span
      className="inline-flex min-w-0 items-center gap-1 text-xs data-[tone=accent]:text-primary data-[tone=danger]:text-destructive data-[tone=success]:text-status-success data-[tone=warning]:text-status-warning-text"
      data-tone={item.tone}
    >
      {item.icon && <PluginDeclarativeIconGlyph name={item.icon} className="size-3.5 shrink-0" />}
      {item.text && <span className="min-w-0 truncate">{item.text}</span>}
    </span>
  )
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="min-w-0 max-w-52"
      aria-label={item.text || tooltip}
      disabled={Boolean(command) && running}
      onClick={
        command
          ? () => {
              onInvoke?.()
              void run(command)
            }
          : undefined
      }
    >
      {content}
    </Button>
  )
  const trigger = (
    <Tooltip>
      <TooltipTrigger asChild>
        {showPopover ? (
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        ) : command ? (
          button
        ) : (
          <span
            className="inline-flex min-w-0 max-w-52 px-1"
            aria-label={item.text ? undefined : tooltip}
          >
            {content}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {item.text && tooltip === item.pluginName ? `${item.text} · ${tooltip}` : tooltip}
      </TooltipContent>
    </Tooltip>
  )

  if (!showPopover) {
    return trigger
  }
  return (
    <Popover>
      {trigger}
      <PopoverContent
        side="top"
        align="end"
        className="w-64 max-w-[calc(100vw-2rem)]"
        aria-label={popover.title || item.text || tooltip}
      >
        <div className="scrollbar-sleek max-h-72 space-y-2 overflow-y-auto p-3">
          {popover.title && <h2 className="text-sm font-medium break-words">{popover.title}</h2>}
          {Boolean(popover.rows?.length) && (
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              {popover.rows?.map(({ label, value }) => (
                <div key={label} className="contents">
                  <dt className="break-words text-muted-foreground">{label}</dt>
                  <dd className="text-right break-words">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {Boolean(popover.actions?.length) && (
            <div className="flex flex-wrap gap-1">
              {popover.actions?.map(({ label, command: action }) => (
                <Button
                  key={action}
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={running}
                  onClick={() => void run(action)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
