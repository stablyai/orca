import type {
  PluginDeclarativeChild,
  PluginDeclarativeNode
} from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import type { PluginDeclarativeEmit } from './PluginDeclarativeControls'
import {
  PluginDeclarativeCheckbox,
  PluginDeclarativeField,
  PluginDeclarativeRadioGroup,
  PluginDeclarativeSlider,
  PluginDeclarativeTextarea
} from './PluginDeclarativeFormControls'
import {
  PluginDeclarativeCollapsible,
  PluginDeclarativeGrid,
  PluginDeclarativeTabs,
  PluginDeclarativeToolbar
} from './PluginDeclarativeLayout'
import { PluginDeclarativeTable } from './PluginDeclarativeTable'
import { PluginDeclarativeTree } from './PluginDeclarativeTree'
import { PluginDeclarativeMarkdown } from './PluginDeclarativeMarkdown'
import { PluginDeclarativeImage } from './PluginDeclarativeImage'
import { PluginDeclarativeRelativeTimeText } from './PluginDeclarativeRelativeTime'
import {
  PluginDeclarativeCallout,
  PluginDeclarativeCodeView,
  PluginDeclarativeKeyValue,
  PluginDeclarativeSkeleton
} from './PluginDeclarativeContent'

const RICH_TYPES = [
  'Textarea',
  'Checkbox',
  'RadioGroup',
  'Slider',
  'Field',
  'Tabs',
  'Tab',
  'Collapsible',
  'Toolbar',
  'Grid',
  'Table',
  'Tree',
  'Markdown',
  'CodeView',
  'Image',
  'KeyValue',
  'Callout',
  'Skeleton',
  'RelativeTime'
] as const
const RICH_TYPE_SET: ReadonlySet<string> = new Set(RICH_TYPES)

/** Catalog 2 components (Orca 1.4.247). */
export type PluginDeclarativeRichNode = Extract<
  PluginDeclarativeNode,
  { type: (typeof RICH_TYPES)[number] }
>

export function isPluginDeclarativeRichNode(
  node: PluginDeclarativeNode
): node is PluginDeclarativeRichNode {
  return RICH_TYPE_SET.has(node.type)
}

export function PluginDeclarativeRichNodeView({
  node,
  emit,
  children,
  renderChildren
}: {
  node: PluginDeclarativeRichNode
  emit: PluginDeclarativeEmit
  /** The node's children, already drawn. */
  children: React.ReactNode
  renderChildren: (children: PluginDeclarativeChild[]) => React.ReactNode
}): React.JSX.Element {
  switch (node.type) {
    case 'Textarea':
      return <PluginDeclarativeTextarea props={node.props} emit={emit} />
    case 'Checkbox':
      return <PluginDeclarativeCheckbox props={node.props} emit={emit} />
    case 'RadioGroup':
      return <PluginDeclarativeRadioGroup props={node.props} emit={emit} />
    case 'Slider':
      return <PluginDeclarativeSlider props={node.props} emit={emit} />
    case 'Field':
      return <PluginDeclarativeField props={node.props}>{children}</PluginDeclarativeField>
    case 'Tabs':
      return (
        <PluginDeclarativeTabs
          props={node.props}
          tabs={node.children}
          emit={emit}
          renderChildren={renderChildren}
        />
      )
    case 'Tab':
      // Drawn by its Tabs; validation keeps a Tab anywhere else out of the tree.
      return <>{children}</>
    case 'Collapsible':
      return (
        <PluginDeclarativeCollapsible props={node.props} emit={emit}>
          {children}
        </PluginDeclarativeCollapsible>
      )
    case 'Toolbar':
      return <PluginDeclarativeToolbar props={node.props}>{children}</PluginDeclarativeToolbar>
    case 'Grid':
      return <PluginDeclarativeGrid props={node.props}>{children}</PluginDeclarativeGrid>
    case 'Table':
      return <PluginDeclarativeTable props={node.props} emit={emit} />
    case 'Tree':
      return <PluginDeclarativeTree props={node.props} emit={emit} />
    case 'Markdown':
      return <PluginDeclarativeMarkdown content={node.props.content} />
    case 'CodeView':
      return <PluginDeclarativeCodeView props={node.props} />
    case 'Image':
      return <PluginDeclarativeImage {...node.props} />
    case 'KeyValue':
      return <PluginDeclarativeKeyValue props={node.props} />
    case 'Callout':
      return <PluginDeclarativeCallout props={node.props}>{children}</PluginDeclarativeCallout>
    case 'Skeleton':
      return <PluginDeclarativeSkeleton props={node.props} />
    case 'RelativeTime':
      return (
        <span
          data-tone={node.props.muted ? 'muted' : (node.props.tone ?? 'neutral')}
          className="text-foreground data-[tone=accent]:text-primary data-[tone=danger]:text-destructive data-[tone=muted]:text-muted-foreground data-[tone=success]:text-status-success data-[tone=warning]:text-status-warning-text"
        >
          <PluginDeclarativeRelativeTimeText at={node.props.at} format={node.props.format} />
        </span>
      )
  }
}
