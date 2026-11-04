import { NativeChatHighlightedCode } from '@/components/native-chat/NativeChatHighlightedCode'
import { MarkdownGitHubCallout } from '@/components/markdown-github-callout'
import { translate } from '@/i18n/i18n'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { PluginDeclarativeIconGlyph } from './plugin-declarative-icons'

/** Read-only code, colored by Orca's own highlighter (built-in and plugin-contributed grammars). */
export function PluginDeclarativeCodeView({
  props
}: {
  props: PluginDeclarativeProps<'CodeView'>
}): React.JSX.Element {
  // A final newline ends the last line; it does not start another.
  const lines = props.code.replace(/\n$/, '').split('\n').length
  const gutter = props.lineNumbers === true && props.wrap !== true
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      {props.label ? (
        <figcaption className="font-mono text-xs text-muted-foreground">{props.label}</figcaption>
      ) : null}
      <div
        data-max-height={props.maxHeight ?? 'md'}
        className="scrollbar-sleek flex min-w-0 overflow-auto rounded-md border border-border bg-muted font-mono text-xs leading-5 text-foreground data-[max-height=lg]:max-h-[32rem] data-[max-height=md]:max-h-96 data-[max-height=sm]:max-h-64"
      >
        {gutter ? (
          <pre
            aria-hidden
            className="sticky left-0 m-0 shrink-0 border-r border-border bg-muted px-2 py-2 text-right text-muted-foreground select-none"
          >
            {Array.from({ length: lines }, (_, index) => index + 1).join('\n')}
          </pre>
        ) : null}
        <pre
          data-wrap={props.wrap === true}
          className="m-0 min-w-0 flex-1 p-2 whitespace-pre data-[wrap=true]:break-words data-[wrap=true]:whitespace-pre-wrap"
        >
          <code>
            {props.language ? (
              <NativeChatHighlightedCode code={props.code} language={props.language} />
            ) : (
              props.code
            )}
          </code>
        </pre>
      </div>
    </figure>
  )
}

export function PluginDeclarativeKeyValue({
  props
}: {
  props: PluginDeclarativeProps<'KeyValue'>
}): React.JSX.Element {
  return (
    <dl
      aria-label={props.label}
      className="m-0 grid min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm"
    >
      {props.items.map((item, index) => (
        // oxlint-disable-next-line react-doctor/no-array-index-as-key -- items are positional data with no identity of their own.
        <div key={index} className="contents">
          <dt className="truncate text-muted-foreground">{item.label}</dt>
          <dd
            data-tone={item.tone ?? 'neutral'}
            data-code={item.code === true}
            className="m-0 min-w-0 break-words text-foreground data-[code=true]:font-mono data-[code=true]:text-xs data-[tone=accent]:text-primary data-[tone=danger]:text-destructive data-[tone=success]:text-status-success data-[tone=warning]:text-status-warning-text"
          >
            {item.value === null ? (
              <span className="text-muted-foreground">–</span>
            ) : typeof item.value === 'boolean' ? (
              item.value ? (
                translate('auto.components.plugins.declarative.KeyValue.yes', 'Yes')
              ) : (
                translate('auto.components.plugins.declarative.KeyValue.no', 'No')
              )
            ) : (
              String(item.value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const CALLOUT_KIND = {
  neutral: 'note',
  accent: 'important',
  success: 'tip',
  warning: 'warning',
  danger: 'caution'
} as const

/** The same callout Orca's Markdown draws for `> [!NOTE]`, in the plugin's tone and title. */
export function PluginDeclarativeCallout({
  props,
  children
}: {
  props: PluginDeclarativeProps<'Callout'>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <MarkdownGitHubCallout
      kind={CALLOUT_KIND[props.tone ?? 'neutral']}
      title={props.title}
      icon={
        props.icon ? (
          <PluginDeclarativeIconGlyph name={props.icon} className="size-[1em] shrink-0" />
        ) : undefined
      }
      className="flex min-w-0 flex-col gap-1 border-l-2 py-0.5 pl-3 text-sm"
    >
      <div className="flex min-w-0 flex-col gap-2 text-foreground">{children}</div>
    </MarkdownGitHubCallout>
  )
}

export function PluginDeclarativeSkeleton({
  props
}: {
  props: PluginDeclarativeProps<'Skeleton'>
}): React.JSX.Element {
  const shape = props.shape ?? 'text'
  const lines = shape === 'text' ? (props.lines ?? 3) : 1
  return (
    <div
      role="status"
      aria-label={
        props.label ?? translate('auto.components.plugins.declarative.Skeleton.loading', 'Loading')
      }
      className="flex min-w-0 flex-col gap-2"
    >
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          aria-hidden
          data-shape={shape}
          data-last={index === lines - 1 && lines > 1}
          className="block animate-pulse bg-muted motion-reduce:animate-none data-[last=true]:w-2/3 data-[shape=block]:h-24 data-[shape=block]:w-full data-[shape=block]:rounded-md data-[shape=circle]:size-8 data-[shape=circle]:rounded-full data-[shape=text]:h-3 data-[shape=text]:rounded"
        />
      ))}
    </div>
  )
}
