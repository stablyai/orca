import type { ReactNode } from 'react'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { PluginDeclarativeIconGlyph } from './plugin-declarative-icons'

/** One list row: a button when the plugin handles presses, otherwise static content. */
export function PluginDeclarativeListItem({
  props,
  onPress,
  trackRef,
  children
}: {
  props: PluginDeclarativeProps<'ListItem'>
  onPress: (() => void) | undefined
  trackRef: ((element: Element | null) => void) | undefined
  children: ReactNode
}): React.JSX.Element {
  const content = (
    <>
      {props.icon ? (
        <PluginDeclarativeIconGlyph
          name={props.icon}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {props.title ? (
          <span className="truncate text-sm text-foreground">{props.title}</span>
        ) : null}
        {props.description ? (
          <span className="truncate text-xs text-muted-foreground">{props.description}</span>
        ) : null}
        {children}
      </span>
    </>
  )
  return (
    <li className="min-w-0">
      {onPress ? (
        <button
          ref={trackRef}
          type="button"
          data-current={props.current ?? false}
          aria-current={props.current ? 'true' : undefined}
          disabled={props.disabled}
          onClick={onPress}
          className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[current=true]:bg-accent"
        >
          {content}
        </button>
      ) : (
        <div
          data-current={props.current ?? false}
          aria-current={props.current ? 'true' : undefined}
          className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 data-[current=true]:bg-accent"
        >
          {content}
        </div>
      )}
    </li>
  )
}
