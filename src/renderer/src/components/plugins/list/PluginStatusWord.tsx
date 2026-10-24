import { statusWordFor, type PluginStatusKind } from '../presentation/plugin-status-presentation'

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

export { statusWordFor } from '../presentation/plugin-status-presentation'
