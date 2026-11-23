import { useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  PluginDeclarativeChild,
  PluginDeclarativeNode,
  PluginDeclarativeProps
} from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import {
  PluginDeclarativeInput,
  PluginDeclarativeSelect,
  PluginDeclarativeSwitch,
  type PluginDeclarativeEmit,
  type PluginDeclarativePress
} from './PluginDeclarativeControls'
import {
  PluginDeclarativeBadge,
  PluginDeclarativeLink,
  PluginDeclarativeProgress,
  PluginDeclarativeSpinner,
  PluginDeclarativeUnsupported
} from './PluginDeclarativeDisplay'
import { PluginDeclarativeListItem } from './PluginDeclarativeListItem'
import {
  isPluginDeclarativeRichNode,
  PluginDeclarativeRichNodeView
} from './PluginDeclarativeRichNode'
import {
  PluginDeclarativeHostServicesContext,
  type PluginDeclarativeHostServices
} from './plugin-declarative-assets'
import { PluginDeclarativeIconGlyph } from './plugin-declarative-icons'
import {
  PluginDeclarativeGestureContext,
  pluginDeclarativeGestureId,
  type PluginDeclarativeGestureGeometry
} from './plugin-declarative-gesture-geometry'

const BUTTON_SIZE = { xs: 'xs', sm: 'sm', md: 'default' } as const
const ICON_BUTTON_SIZE = { xs: 'icon-xs', sm: 'icon-sm', md: 'icon' } as const

type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'destructive'
  | 'destructive-chip'

/** The shared tone vocabulary on Orca's button variants: colour only where it marks a role. */
function buttonVariant(props: PluginDeclarativeProps<'Button' | 'IconButton'>): ButtonVariant {
  const variant = props.variant ?? 'outline'
  if (props.tone === 'danger') {
    return variant === 'solid' ? 'destructive' : 'destructive-chip'
  }
  if (variant === 'solid') {
    return props.tone === 'accent' ? 'default' : 'secondary'
  }
  return variant
}

export type PluginDeclarativeViewProps = {
  /** A tree that already passed `parsePluginDeclarativeTree`. */
  tree: PluginDeclarativeNode | null
  /** Fires a guest callback; the caller adds the revision the tree came from. */
  onEvent: PluginDeclarativeEmit
  /** Opens a validated `http(s):`/`mailto:` href outside Orca, once `gestureId`'s control settled. */
  onOpenLink?: (href: string, gestureId: string) => void
  /** Object URL for a plugin-relative image file, or null when it cannot be shown. */
  onLoadImage?: (path: string) => Promise<string | null>
  /** Tracks where granting controls sit, so a press can be judged settled. */
  gestures?: PluginDeclarativeGestureGeometry
}

type RenderContext = {
  emit: PluginDeclarativeEmit
  openLink?: (href: string, gestureId: string) => void
  /** Inside Text or Heading, where Text flows inline instead of as a block. */
  inline: boolean
}

function renderChildren(children: PluginDeclarativeChild[], context: RenderContext) {
  return children.map((child, index) => {
    if (typeof child === 'string') {
      return child
    }
    const key = child.key ?? `#${index}`
    // oxlint-disable-next-line react-doctor/no-array-index-as-key -- the guest keys every node; the index only covers hand-built trees.
    return <PluginDeclarativeNodeView key={key} node={child} context={context} />
  })
}

function PluginDeclarativeNodeView({
  node,
  context
}: {
  node: PluginDeclarativeNode
  context: RenderContext
}): React.JSX.Element {
  const { emit } = context
  const gestures = useContext(PluginDeclarativeGestureContext)
  const press = (control: PluginDeclarativePress['control'], callback?: { $callback: string }) =>
    callback
      ? () =>
          emit(callback.$callback, [], {
            press: {
              control,
              gestureId: pluginDeclarativeGestureId.callback(callback.$callback),
              grants: true
            }
          })
      : undefined
  const trackPress = (callback?: { $callback: string }) =>
    callback && gestures
      ? gestures.refFor(pluginDeclarativeGestureId.callback(callback.$callback))
      : undefined
  const children = renderChildren(node.children, {
    ...context,
    inline: node.type === 'Text' || node.type === 'Heading'
  })
  if (isPluginDeclarativeRichNode(node)) {
    return (
      <PluginDeclarativeRichNodeView
        node={node}
        emit={emit}
        renderChildren={(nested) => renderChildren(nested, { ...context, inline: false })}
      >
        {children}
      </PluginDeclarativeRichNodeView>
    )
  }
  switch (node.type) {
    case 'Stack':
      return (
        <div
          data-gap={node.props.gap ?? 'md'}
          data-align={node.props.align ?? 'default'}
          // Default: fields and tables fill the width, buttons keep their own; `stretch` stretches all.
          className="flex min-w-0 flex-col data-[align=center]:items-center data-[align=default]:items-stretch data-[align=default]:[&>[data-slot=button]]:self-start data-[align=end]:items-end data-[align=start]:items-start data-[align=stretch]:items-stretch data-[gap=lg]:gap-4 data-[gap=md]:gap-3 data-[gap=none]:gap-0 data-[gap=sm]:gap-2 data-[gap=xs]:gap-1"
        >
          {children}
        </div>
      )
    case 'Row':
      return (
        <div
          data-gap={node.props.gap ?? 'sm'}
          data-align={node.props.align ?? 'center'}
          data-justify={node.props.justify ?? 'start'}
          data-wrap={node.props.wrap ?? false}
          className="flex min-w-0 flex-row data-[align=center]:items-center data-[align=end]:items-end data-[align=start]:items-start data-[align=stretch]:items-stretch data-[gap=lg]:gap-4 data-[gap=md]:gap-3 data-[gap=none]:gap-0 data-[gap=sm]:gap-2 data-[gap=xs]:gap-1 data-[justify=between]:justify-between data-[justify=center]:justify-center data-[justify=end]:justify-end data-[wrap=true]:flex-wrap"
        >
          {children}
        </div>
      )
    case 'Text':
      return (
        <span
          data-tone={node.props.muted ? 'muted' : (node.props.tone ?? 'neutral')}
          data-size={node.props.size ?? 'sm'}
          data-weight={node.props.weight ?? 'regular'}
          data-truncate={node.props.truncate ?? false}
          data-inline={context.inline}
          className="min-w-0 break-words text-foreground data-[inline=false]:block data-[size=md]:text-base data-[size=sm]:text-sm data-[size=xs]:text-xs data-[tone=accent]:text-primary data-[tone=danger]:text-destructive data-[tone=muted]:text-muted-foreground data-[tone=success]:text-status-success data-[tone=warning]:text-status-warning-text data-[truncate=true]:truncate data-[weight=medium]:font-medium data-[weight=semibold]:font-semibold"
        >
          {children}
        </span>
      )
    case 'Heading':
      // Under the panel's own title, so plugin levels 1–3 are document levels 2–4.
      if (node.props.level === 3) {
        return (
          <h4 className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            {children}
          </h4>
        )
      }
      if (node.props.level === 2) {
        return <h3 className="text-sm font-semibold text-foreground">{children}</h3>
      }
      return <h2 className="text-base font-semibold text-foreground">{children}</h2>
    case 'Button': {
      const button = (
        <Button
          type="button"
          variant={buttonVariant(node.props)}
          size={BUTTON_SIZE[node.props.size ?? 'sm']}
          disabled={node.props.disabled}
          ref={trackPress(node.props.onPress)}
          onClick={press('Button', node.props.onPress)}
        >
          {node.props.icon ? <PluginDeclarativeIconGlyph name={node.props.icon} /> : null}
          {children}
        </Button>
      )
      return node.props.tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {node.props.tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )
    }
    case 'IconButton':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={node.props.variant ? buttonVariant(node.props) : 'ghost'}
              size={ICON_BUTTON_SIZE[node.props.size ?? 'sm']}
              disabled={node.props.disabled}
              aria-label={node.props.label}
              ref={trackPress(node.props.onPress)}
              onClick={press('IconButton', node.props.onPress)}
            >
              <PluginDeclarativeIconGlyph name={node.props.icon} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {node.props.tooltip ?? node.props.label}
          </TooltipContent>
        </Tooltip>
      )
    case 'Badge':
      return <PluginDeclarativeBadge tone={node.props.tone}>{children}</PluginDeclarativeBadge>
    case 'Card':
      return (
        <Card>
          {node.props.title || node.props.description ? (
            <CardHeader>
              {node.props.title ? <CardTitle>{node.props.title}</CardTitle> : null}
              {node.props.description ? (
                <CardDescription>{node.props.description}</CardDescription>
              ) : null}
            </CardHeader>
          ) : null}
          <CardContent>
            <div className="flex min-w-0 flex-col gap-3">{children}</div>
          </CardContent>
        </Card>
      )
    case 'List':
      return (
        <ul aria-label={node.props.label} className="flex min-w-0 flex-col">
          {children}
        </ul>
      )
    case 'ListItem':
      return (
        <PluginDeclarativeListItem
          props={node.props}
          onPress={press('ListItem', node.props.onPress)}
          trackRef={trackPress(node.props.onPress)}
        >
          {children}
        </PluginDeclarativeListItem>
      )
    case 'Input':
      return <PluginDeclarativeInput props={node.props} emit={emit} />
    case 'Switch':
      return <PluginDeclarativeSwitch props={node.props} emit={emit} />
    case 'Select':
      return <PluginDeclarativeSelect props={node.props} emit={emit} />
    case 'Separator':
      return <Separator orientation={node.props.orientation ?? 'horizontal'} />
    case 'Progress':
      return <PluginDeclarativeProgress props={node.props} />
    case 'Spinner':
      return <PluginDeclarativeSpinner props={node.props} />
    case 'EmptyState':
      return (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          {node.props.icon ? (
            <PluginDeclarativeIconGlyph
              name={node.props.icon}
              className="size-6 text-muted-foreground"
            />
          ) : null}
          <p className="text-sm font-medium text-foreground">{node.props.title}</p>
          {node.props.description ? (
            <p className="text-xs text-muted-foreground">{node.props.description}</p>
          ) : null}
          {children.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2 pt-1">{children}</div>
          ) : null}
        </div>
      )
    case 'Link': {
      const { href } = node.props
      const onPress = node.props.onPress?.$callback
      const gestureId = href
        ? pluginDeclarativeGestureId.href(href)
        : onPress
          ? pluginDeclarativeGestureId.callback(onPress)
          : null
      return (
        <PluginDeclarativeLink
          props={node.props}
          trackRef={gestureId && gestures ? gestures.refFor(gestureId) : undefined}
          onOpen={
            href
              ? (url) => context.openLink?.(url, pluginDeclarativeGestureId.href(url))
              : undefined
          }
          onPress={
            onPress && gestureId
              ? (grants) => emit(onPress, [], { press: { control: 'Link', gestureId, grants } })
              : undefined
          }
        >
          {children}
        </PluginDeclarativeLink>
      )
    }
    case 'Code':
      return node.props.block ? (
        <pre className="scrollbar-sleek overflow-x-auto rounded-md border border-border bg-muted p-2 font-mono text-xs text-foreground">
          <code>{children}</code>
        </pre>
      ) : (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
          {children}
        </code>
      )
    case 'Unsupported':
      return <PluginDeclarativeUnsupported name={node.props.name} />
  }
}

/** Renders a validated declarative plugin tree with Orca's own components. */
export function PluginDeclarativeView({
  tree,
  onEvent,
  onOpenLink,
  onLoadImage,
  gestures
}: PluginDeclarativeViewProps): React.JSX.Element {
  const services = useMemo<PluginDeclarativeHostServices>(
    () => ({ openLink: onOpenLink, loadImage: onLoadImage }),
    [onLoadImage, onOpenLink]
  )
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Every commit can move controls (a sibling grew, an ancestor reflowed), so re-measure.
  useLayoutEffect(() => {
    gestures?.setContainer(containerRef.current)
    gestures?.sample()
  })
  return (
    <PluginDeclarativeGestureContext.Provider value={gestures ?? null}>
      <PluginDeclarativeHostServicesContext.Provider value={services}>
        <div
          ref={containerRef}
          className="scrollbar-sleek flex h-full min-h-0 flex-col overflow-y-auto p-3 text-sm text-foreground"
        >
          {tree ? (
            <PluginDeclarativeNodeView
              node={tree}
              context={{ emit: onEvent, openLink: onOpenLink, inline: false }}
            />
          ) : null}
        </div>
      </PluginDeclarativeHostServicesContext.Provider>
    </PluginDeclarativeGestureContext.Provider>
  )
}
