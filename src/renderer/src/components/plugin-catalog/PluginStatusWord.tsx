import { translate } from '@/i18n/i18n'
import { pluginStatusLabel, type PluginStatusKind } from '../settings/plugin-status-presentation'

/** A status dot and word; narrow lists keep only the dot, the word stays for screen readers. */
export function StatusWord({ kind }: { kind: PluginStatusKind }): React.JSX.Element {
  return (
    <span
      data-kind={kind}
      className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground data-[kind=blocked]:text-destructive data-[kind=error]:text-destructive data-[kind=invalid]:text-destructive data-[kind=review]:text-foreground"
    >
      <span
        aria-hidden="true"
        data-kind={kind}
        className="size-1.5 rounded-full bg-current data-[kind=disabled]:bg-transparent data-[kind=disabled]:ring-1 data-[kind=disabled]:ring-current data-[kind=enabled]:bg-status-success data-[kind=restarting]:bg-status-success data-[kind=running]:bg-status-success"
      />
      <span className="@max-xl/plugin-list:sr-only">{statusWordFor(kind)}</span>
    </span>
  )
}

export function statusWordFor(kind: PluginStatusKind): string {
  if (kind === 'error') {
    return translate('auto.components.settings.PluginManagerRows.stopped', 'Stopped')
  }
  if (kind === 'invalid') {
    return translate('auto.components.settings.PluginManagerRows.cantLoad', 'Can’t load')
  }
  if (kind === 'enabled') {
    return translate('auto.components.settings.PluginManagerRows.on', 'On')
  }
  if (kind === 'disabled') {
    return translate('auto.components.settings.PluginManagerRows.off', 'Off')
  }
  return pluginStatusLabel(kind)
}
