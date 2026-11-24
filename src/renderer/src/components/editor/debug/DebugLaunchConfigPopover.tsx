import { Settings2 } from 'lucide-react'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useTranslate } from '@/i18n/use-translate'

export function DebugLaunchConfigPopover({
  requestMode,
  argsText,
  cwdOverride,
  extraJson,
  onChangeRequestMode,
  onChangeArgsText,
  onChangeCwdOverride,
  onChangeExtraJson
}: {
  requestMode: 'launch' | 'attach'
  argsText: string
  cwdOverride: string
  extraJson: string
  onChangeRequestMode: (mode: 'launch' | 'attach') => void
  onChangeArgsText: (val: string) => void
  onChangeCwdOverride: (val: string) => void
  onChangeExtraJson: (val: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t('auto.components.editor.debug.launchConfigTitle', 'Debug Launch Config')}
        >
          <Settings2 className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-2 p-3 text-xs">
          <div className="font-medium text-foreground">
            {t('auto.components.editor.debug.launchConfigHeading', '启动配置')}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
              {t('auto.components.editor.debug.modeLabel', '模式')}
            </span>
            <select
              value={requestMode}
              onChange={(e) => {
                const next = e.target.value
                if (next === 'launch' || next === 'attach') {
                  onChangeRequestMode(next)
                }
              }}
              className="h-7 flex-1 rounded border border-border/70 bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
            >
              <option value="launch">
                {t('auto.components.editor.debug.modeLaunch', 'Launch (启动当前文件)')}
              </option>
              <option value="attach">
                {t('auto.components.editor.debug.modeAttach', 'Attach (附加运行中进程)')}
              </option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
              {t('auto.components.editor.debug.argsLabel', '参数')}
            </span>
            <input
              type="text"
              value={argsText}
              onChange={(e) => onChangeArgsText(e.target.value)}
              placeholder={t('auto.components.editor.debug.argsPlaceholder', '--port 3000')}
              className="h-7 flex-1 rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
              {t('auto.components.editor.debug.cwdLabel', '目录')}
            </span>
            <input
              type="text"
              value={cwdOverride}
              onChange={(e) => onChangeCwdOverride(e.target.value)}
              placeholder={t('auto.components.editor.debug.cwdPlaceholder', '默认当前文件所在目录')}
              className="h-7 flex-1 rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
            />
          </div>
          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground">
              {t(
                'auto.components.editor.debug.extraJsonLabel',
                '额外 DAP JSON（可选，如 stopOnEntry / port）'
              )}
            </div>
            <input
              type="text"
              value={extraJson}
              onChange={(e) => onChangeExtraJson(e.target.value)}
              placeholder={t(
                'auto.components.editor.debug.extraJsonPlaceholder',
                '{"stopOnEntry": true}'
              )}
              className="h-7 w-full rounded border border-border/70 bg-background px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
