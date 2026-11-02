import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PluginDeclarativeIconGlyph } from '@/components/plugins/declarative/plugin-declarative-icons'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { translate } from '@/i18n/i18n'
import {
  usePluginStatusBarItems,
  type ActivePluginStatusBarItem
} from '@/store/plugin-status-bar-items'

const ITEM_CLASS =
  'inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground data-[pressable=true]:cursor-pointer data-[pressable=true]:hover:bg-accent/70 data-[pressable=true]:hover:text-foreground data-[tone=accent]:text-primary data-[tone=danger]:text-destructive data-[tone=success]:text-status-success data-[tone=warning]:text-status-warning-text'

function runItemCommand(item: ActivePluginStatusBarItem): void {
  if (!item.command) {
    return
  }
  void executePluginCommand(item.command, 'plugin-palette').catch(() => {
    toast.error(translate('auto.App.pluginCommandFailed', 'Could not run the plugin command.'))
  })
}

function PluginStatusBarItem({
  item,
  iconOnly
}: {
  item: ActivePluginStatusBarItem
  iconOnly: boolean
}): React.JSX.Element {
  const showText = item.text !== undefined && (!iconOnly || !item.icon)
  const content = (
    <>
      {item.icon ? <PluginDeclarativeIconGlyph name={item.icon} className="size-3" /> : null}
      {showText ? <span className="text-[11px]">{item.text}</span> : null}
    </>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {item.command ? (
          <button
            type="button"
            className={ITEM_CLASS}
            data-tone={item.tone}
            data-pressable="true"
            aria-label={item.text ? `${item.text}, ${item.tooltip}` : item.tooltip}
            onClick={() => runItemCommand(item)}
          >
            {content}
          </button>
        ) : (
          <span className={ITEM_CLASS} data-tone={item.tone} aria-label={item.tooltip}>
            {content}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {item.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** Items enabled plugins declare in `contributes.statusBarItems`. */
export function PluginStatusBarItems({ iconOnly }: { iconOnly: boolean }): React.JSX.Element {
  const items = usePluginStatusBarItems()
  return (
    <>
      {items.map((item) => (
        <PluginStatusBarItem key={item.key} item={item} iconOnly={iconOnly} />
      ))}
    </>
  )
}
