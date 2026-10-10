import React from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getCodeBlockLanguageLabel } from '@/components/editor/rich-markdown-code-block-languages'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatHighlightedCode } from './NativeChatHighlightedCode'

/** Code fences need their own copy target rather than the whole chat message. */
export function NativeChatCodeBlock({
  children,
  language,
  plain = false
}: {
  children?: React.ReactNode
  language?: string
  plain?: boolean
}): React.JSX.Element {
  const code = extractCodeText(children)

  return (
    <div className="group/code relative my-3 min-w-0 max-w-full overflow-hidden rounded-lg border border-chat-code-border bg-chat-code-surface">
      {language ? (
        <div className="flex h-7.5 items-center justify-between px-3">
          <span
            data-code-language={language}
            className="min-w-0 font-sans text-xs text-chat-foreground-faint"
          >
            <span className="truncate">{getCodeBlockLanguageLabel(language)}</span>
          </span>
          {code ? (
            <NativeChatCopyButton
              text={code}
              label={translate('components.native-chat.copyCode', 'Copy code')}
              className="-mr-1"
            />
          ) : null}
        </div>
      ) : null}
      <pre
        data-native-chat-code-content
        className={cn(
          'scrollbar-sleek m-0 max-w-full overflow-x-auto font-mono text-[12px] text-chat-code-foreground',
          language ? 'px-3.5 pt-0.5 pb-3' : 'p-3 pr-10'
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
        <NativeChatCopyButton
          text={code}
          label={translate('components.native-chat.copyCode', 'Copy code')}
          className="absolute right-2 top-2 opacity-100 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover/code:pointer-events-auto group-hover/code:opacity-100 [[class~='group/code']:has(:focus-visible)_&]:pointer-events-auto [[class~='group/code']:has(:focus-visible)_&]:opacity-100"
        />
      ) : null}
    </div>
  )
}

/** For dimmed rows: their code keeps the row's faint color, so it is not tokenized at all. */
export function NativeChatPlainCodeBlock(props: {
  children?: React.ReactNode
  language?: string
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
