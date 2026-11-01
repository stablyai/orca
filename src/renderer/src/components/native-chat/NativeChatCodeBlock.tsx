import React, { useContext } from 'react'
import { WrapText } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getCodeFenceLanguageLabel } from './code-fence-language-label'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import {
  NativeChatMarkdownRowKeyContext,
  useNativeChatDisclosure
} from './native-chat-disclosure-store'
import { NativeChatHighlightedCode } from './NativeChatHighlightedCode'

/** Code fences need their own copy target rather than the whole chat message. */
export function NativeChatCodeBlock({
  children,
  language,
  sourceLine,
  plain = false
}: {
  children?: React.ReactNode
  language?: string
  sourceLine?: number
  plain?: boolean
}): React.JSX.Element {
  const code = extractCodeText(children)
  const rowKey = useContext(NativeChatMarkdownRowKeyContext)
  // Keep wrap state in the transcript store so windowing and streaming block recuts cannot reset it; never persist it.
  const { open: wrapped, setOpen: setWrapped } = useNativeChatDisclosure(
    rowKey === undefined || sourceLine === undefined
      ? undefined
      : `code-wrap:${rowKey}:${sourceLine}`,
    false
  )
  const actions = code ? (
    <>
      <NativeChatCodeWrapButton wrapped={wrapped} onToggle={() => setWrapped(!wrapped)} />
      <NativeChatCopyButton
        text={code}
        label={translate('components.native-chat.copyCode', 'Copy code')}
      />
    </>
  ) : null

  return (
    <div
      data-native-chat-code-block={code ? '' : undefined}
      className="group/code relative my-3 min-w-0 max-w-full overflow-hidden rounded-lg border border-chat-code-border bg-chat-code-surface"
    >
      {language ? (
        <div className="flex h-7.5 items-center justify-between px-3">
          <span
            data-code-language={language}
            className="min-w-0 font-sans text-xs text-chat-foreground-faint"
          >
            <span className="truncate">{getCodeFenceLanguageLabel(language)}</span>
          </span>
          {code ? <div className="-mr-1 flex items-center gap-0.5">{actions}</div> : null}
        </div>
      ) : null}
      <pre
        data-native-chat-code-content
        className={cn(
          'scrollbar-sleek m-0 max-w-full font-mono text-chat-code text-chat-code-foreground',
          wrapped ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'overflow-x-auto',
          language ? 'px-3.5 pt-0.5 pb-3' : 'p-3 pr-16'
        )}
      >
        {language && code && !plain ? (
          <code>
            <NativeChatHighlightedCode code={code} language={language} />
          </code>
        ) : (
          children
        )}
      </pre>
      {code && !language ? (
        <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-100 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover/code:pointer-events-auto group-hover/code:opacity-100 [[class~='group/code']:has(:focus-visible)_&]:pointer-events-auto [[class~='group/code']:has(:focus-visible)_&]:opacity-100">
          {actions}
        </div>
      ) : null}
    </div>
  )
}

function NativeChatCodeWrapButton({
  wrapped,
  onToggle
}: {
  wrapped: boolean
  onToggle: () => void
}): React.JSX.Element {
  const label = wrapped
    ? translate('components.native-chat.disableLineWrap', 'Disable line wrap')
    : translate('components.native-chat.wrapLines', 'Wrap lines')
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={wrapped}
      title={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground"
    >
      <WrapText className="size-3.5" />
    </button>
  )
}

/** For dimmed rows: their code keeps the row's faint color, so it is not tokenized at all. */
export function NativeChatPlainCodeBlock(props: {
  children?: React.ReactNode
  language?: string
  sourceLine?: number
}): React.JSX.Element {
  return <NativeChatCodeBlock {...props} plain />
}

function extractCodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractCodeText).join('')
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractCodeText(node.props.children)
  }
  return ''
}
