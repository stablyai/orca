import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type {
  PluginDeclarativeChild,
  PluginDeclarativeNode,
  PluginDeclarativeProps
} from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { usePluginDeclarativeHostValue } from './plugin-declarative-host-value'
import { sendValue, type PluginDeclarativeEmit } from './PluginDeclarativeControls'
import { PluginDeclarativeIconGlyph } from './plugin-declarative-icons'

type TabNode = Extract<PluginDeclarativeNode, { type: 'Tab' }>

function isTab(child: PluginDeclarativeChild): child is TabNode {
  return typeof child !== 'string' && child.type === 'Tab'
}

/** Only the selected tab's children are drawn, so hidden tabs cost nothing. */
export function PluginDeclarativeTabs({
  props,
  tabs,
  emit,
  renderChildren
}: {
  props: PluginDeclarativeProps<'Tabs'>
  tabs: PluginDeclarativeChild[]
  emit: PluginDeclarativeEmit
  renderChildren: (children: PluginDeclarativeChild[]) => React.ReactNode
}): React.JSX.Element {
  const items = tabs.filter(isTab)
  const first = items.find((tab) => !tab.props.disabled)?.props.value ?? ''
  const { value, change } = usePluginDeclarativeHostValue({
    value: props.value,
    defaultValue: props.defaultValue,
    fallback: first,
    acked: props.$edit,
    actTarget: props,
    callback: props.onChange?.$callback,
    send: sendValue(emit)
  })
  const active = items.some((tab) => tab.props.value === value) ? value : first
  const selected = items.find((tab) => tab.props.value === active)
  return (
    <Tabs value={active} onValueChange={change} className="min-w-0">
      <TabsList variant="line" aria-label={props.label}>
        {items.map((tab) => (
          <TabsTrigger key={tab.props.value} value={tab.props.value} disabled={tab.props.disabled}>
            {tab.props.icon ? <PluginDeclarativeIconGlyph name={tab.props.icon} /> : null}
            {tab.props.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {selected ? (
        <TabsContent value={selected.props.value} className="min-w-0">
          <div className="flex min-w-0 flex-col gap-3">{renderChildren(selected.children)}</div>
        </TabsContent>
      ) : null}
    </Tabs>
  )
}

export function PluginDeclarativeCollapsible({
  props,
  emit,
  children
}: {
  props: PluginDeclarativeProps<'Collapsible'>
  emit: PluginDeclarativeEmit
  children: React.ReactNode
}): React.JSX.Element {
  const { value, change, readOnly } = usePluginDeclarativeHostValue({
    value: props.open,
    defaultValue: props.defaultOpen,
    fallback: false,
    acked: props.$edit,
    actTarget: props,
    callback: props.onChange?.$callback,
    send: sendValue(emit)
  })
  return (
    <Collapsible open={value} onOpenChange={change} disabled={props.disabled || readOnly}>
      <CollapsibleTrigger variant="row" className="justify-start">
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate">{props.title}</span>
            {props.description ? (
              <span className="truncate text-xs font-normal text-muted-foreground">
                {props.description}
              </span>
            ) : null}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex min-w-0 flex-col gap-3 pt-2 pl-6">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const TOOLBAR_FOCUSABLE =
  'button:not(:disabled), [role="link"], input:not(:disabled), [role="combobox"]'

/** One tab stop per control; arrow keys, Home and End move between them, as in a menu bar. */
export function PluginDeclarativeToolbar({
  props,
  children
}: {
  props: PluginDeclarativeProps<'Toolbar'>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label={props.label}
      data-gap={props.gap ?? 'xs'}
      className="flex min-w-0 flex-wrap items-center data-[gap=lg]:gap-4 data-[gap=md]:gap-3 data-[gap=none]:gap-0 data-[gap=sm]:gap-2 data-[gap=xs]:gap-1"
      onKeyDown={(event) => {
        const moves: Record<string, number | 'first' | 'last'> = {
          ArrowRight: 1,
          ArrowLeft: -1,
          Home: 'first',
          End: 'last'
        }
        const move = moves[event.key]
        const target = event.target
        if (move === undefined || !(target instanceof HTMLElement) || target.tagName === 'INPUT') {
          return
        }
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(TOOLBAR_FOCUSABLE)]
        const index = controls.indexOf(target)
        if (index === -1) {
          return
        }
        const next =
          move === 'first'
            ? 0
            : move === 'last'
              ? controls.length - 1
              : (index + move + controls.length) % controls.length
        event.preventDefault()
        controls[next]?.focus()
      }}
    >
      {children}
    </div>
  )
}

export function PluginDeclarativeGrid({
  props,
  children
}: {
  props: PluginDeclarativeProps<'Grid'>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-columns={props.minItemWidth ? 'auto' : (props.columns ?? 2)}
      data-min={props.minItemWidth ?? 'none'}
      data-gap={props.gap ?? 'md'}
      className="grid min-w-0 data-[columns=1]:grid-cols-1 data-[columns=2]:grid-cols-2 data-[columns=3]:grid-cols-3 data-[columns=4]:grid-cols-4 data-[columns=5]:grid-cols-5 data-[columns=6]:grid-cols-6 data-[gap=lg]:gap-4 data-[gap=md]:gap-3 data-[gap=none]:gap-0 data-[gap=sm]:gap-2 data-[gap=xs]:gap-1 data-[min=lg]:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] data-[min=md]:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] data-[min=sm]:grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] data-[min=xs]:grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] [&>*]:min-w-0"
    >
      {children}
    </div>
  )
}
