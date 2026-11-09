import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'

type BoxProps = PluginDeclarativeProps<'Box'>

/** Validated px numbers or whole percents only, so nothing else reaches inline style. */
function sizeStyle(props: BoxProps): React.CSSProperties {
  return {
    width: props.width,
    height: props.height,
    minWidth: props.minWidth,
    minHeight: props.minHeight,
    maxWidth: props.maxWidth,
    maxHeight: props.maxHeight
  }
}

function borderOf(border: BoxProps['border']): string {
  if (border === true) {
    return 'neutral'
  }
  return border === false || border === undefined ? 'none' : border
}

/** A general layout container: flex row/column or equal-column grid, styled through theme tokens. */
export function PluginDeclarativeBox({
  props,
  children
}: {
  props: BoxProps
  children: React.ReactNode
}): React.JSX.Element {
  const layout = props.columns ? 'grid' : (props.direction ?? 'column')
  return (
    <div
      data-layout={layout}
      data-columns={props.columns ?? 'none'}
      data-gap={props.gap ?? 'none'}
      // The axis props override `padding` on their side only.
      data-padding-x={props.paddingX ?? props.padding ?? 'none'}
      data-padding-y={props.paddingY ?? props.padding ?? 'none'}
      data-margin={props.margin ?? 'none'}
      // Unset, as Row and Stack: a row centres; a column fills the width but buttons keep theirs.
      data-align={props.align ?? (layout === 'row' ? 'center' : 'default')}
      data-justify={props.justify ?? 'start'}
      data-wrap={props.wrap ?? false}
      data-grow={props.grow ?? 'unset'}
      data-shrink={props.shrink ?? 'unset'}
      data-scroll={props.scroll ?? 'none'}
      data-border={borderOf(props.border)}
      data-radius={props.radius ?? 'none'}
      data-background={props.background ?? 'none'}
      style={sizeStyle(props)}
      className="scrollbar-sleek box-border flex min-w-0 data-[align=center]:items-center data-[align=default]:items-stretch data-[align=default]:[&>[data-slot=button]]:self-start data-[align=end]:items-end data-[align=start]:items-start data-[align=stretch]:items-stretch data-[background=accent]:bg-[color-mix(in_srgb,var(--primary)_12%,var(--background))] data-[background=card]:bg-card data-[background=card]:text-card-foreground data-[background=danger]:bg-[color-mix(in_srgb,var(--destructive)_12%,var(--background))] data-[background=muted]:bg-muted data-[background=neutral]:bg-muted data-[background=success]:bg-status-success-background data-[background=warning]:bg-[color-mix(in_srgb,var(--status-warning)_14%,var(--background))] data-[border=accent]:border data-[border=accent]:border-primary data-[border=danger]:border data-[border=danger]:border-destructive data-[border=neutral]:border data-[border=neutral]:border-border data-[border=success]:border data-[border=success]:border-status-success-border data-[border=warning]:border data-[border=warning]:border-status-warning data-[columns=1]:grid-cols-1 data-[columns=2]:grid-cols-2 data-[columns=3]:grid-cols-3 data-[columns=4]:grid-cols-4 data-[columns=5]:grid-cols-5 data-[columns=6]:grid-cols-6 data-[gap=lg]:gap-4 data-[gap=md]:gap-3 data-[gap=sm]:gap-2 data-[gap=xs]:gap-1 data-[grow=false]:grow-0 data-[grow=true]:grow data-[justify=between]:justify-between data-[justify=center]:justify-center data-[justify=end]:justify-end data-[layout=column]:flex-col data-[layout=grid]:grid data-[layout=row]:flex-row data-[margin=lg]:m-4 data-[margin=md]:m-3 data-[margin=sm]:m-2 data-[margin=xs]:m-1 data-[padding-x=lg]:px-4 data-[padding-x=md]:px-3 data-[padding-x=sm]:px-2 data-[padding-x=xs]:px-1 data-[padding-y=lg]:py-4 data-[padding-y=md]:py-3 data-[padding-y=sm]:py-2 data-[padding-y=xs]:py-1 data-[radius=full]:rounded-full data-[radius=lg]:rounded-lg data-[radius=md]:rounded-md data-[radius=sm]:rounded-sm data-[scroll=both]:overflow-auto data-[scroll=x]:overflow-x-auto data-[scroll=y]:overflow-y-auto data-[shrink=false]:shrink-0 data-[shrink=true]:shrink data-[wrap=true]:flex-wrap [&>*]:min-w-0"
    >
      {children}
    </div>
  )
}
