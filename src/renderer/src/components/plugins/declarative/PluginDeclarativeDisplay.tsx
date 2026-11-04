import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import type {
  PluginDeclarativeProps,
  PluginDeclarativeTone
} from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'

/** Badge tone: success and warning have no badge colour, so they carry a status dot. */
export function PluginDeclarativeBadge({
  tone,
  children
}: {
  tone: PluginDeclarativeTone | undefined
  children: React.ReactNode
}): React.JSX.Element {
  switch (tone) {
    case 'accent':
      return <Badge variant="default">{children}</Badge>
    case 'danger':
      return <Badge variant="destructive">{children}</Badge>
    case 'success':
      return (
        <Badge variant="outline">
          <span aria-hidden className="size-1.5 rounded-full bg-status-success" />
          {children}
        </Badge>
      )
    case 'warning':
      return (
        <Badge variant="outline">
          <span aria-hidden className="size-1.5 rounded-full bg-status-warning" />
          {children}
        </Badge>
      )
    case 'neutral':
    case undefined:
      return <Badge variant="secondary">{children}</Badge>
  }
}

export function PluginDeclarativeProgress({
  props
}: {
  props: PluginDeclarativeProps<'Progress'>
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.labelHidden ? null : (
        <span className="text-xs text-muted-foreground">{props.label}</span>
      )}
      <Progress value={props.value ?? null} aria-label={props.label} />
    </div>
  )
}

export function PluginDeclarativeSpinner({
  props
}: {
  props: PluginDeclarativeProps<'Spinner'>
}): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label={props.labelHidden ? props.label : undefined}
      className="inline-flex items-center gap-2 text-sm text-muted-foreground"
    >
      <LoadingSpinner className="size-4" />
      {props.labelHidden ? null : <span>{props.label}</span>}
    </span>
  )
}

/**
 * Link without a real href: every open goes through the host's checked path (no middle-click,
 * drag or context-menu "open link" that bypasses it).
 */
export function PluginDeclarativeLink({
  props,
  trackRef,
  onOpen,
  onPress,
  children
}: {
  props: PluginDeclarativeProps<'Link'>
  trackRef: ((element: Element | null) => void) | undefined
  onOpen: ((href: string) => void) | undefined
  onPress: ((grantsGesture: boolean) => void) | undefined
  children: React.ReactNode
}): React.JSX.Element {
  const { href } = props
  return (
    <button
      ref={trackRef}
      type="button"
      role="link"
      title={href}
      className="cursor-pointer text-primary underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={() => {
        if (href) {
          onOpen?.(href)
        }
        // The href open already used the press; onPress must not grant a second gesture.
        onPress?.(!href)
      }}
    >
      {children}
    </button>
  )
}

/** A component this Orca does not know: neutral, so the rest of the panel still works. */
export function PluginDeclarativeUnsupported({ name }: { name: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
      {translate(
        'auto.components.plugins.declarative.PluginDeclarativeView.unsupported',
        '{{value0}} is not available in this version of Orca',
        { value0: name }
      )}
    </div>
  )
}
