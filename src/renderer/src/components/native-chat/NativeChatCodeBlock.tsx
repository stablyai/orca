import React from 'react'
import { Code2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getCodeBlockLanguageLabel } from '@/components/editor/rich-markdown-code-block-languages'
import { NativeChatCopyButton } from './NativeChatCopyButton'

/** Code fences need their own copy target rather than the whole chat message. */
export function NativeChatCodeBlock({
  children,
  language
}: {
  children?: React.ReactNode
  language?: string
}): React.JSX.Element {
  const code = extractCodeText(children)

  return (
    <div className="group/code relative my-3 min-w-0 max-w-full overflow-hidden rounded-md bg-accent">
      {language ? (
        <div className="flex h-9 items-center justify-between border-b border-border/60 px-3">
          <span
            data-code-language={language}
            className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
          >
            <Code2 className="size-3.5 shrink-0" />
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
        className={cn(
          'scrollbar-sleek m-0 max-h-80 max-w-full overflow-x-auto p-3 font-mono text-[12px]',
          !language && 'pr-10'
        )}
      >
        {children}
      </pre>
      {code && !language ? (
        <NativeChatCopyButton
          text={code}
          label={translate('components.native-chat.copyCode', 'Copy code')}
          className="absolute right-2 top-2 opacity-100 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover/code:pointer-events-auto group-hover/code:opacity-100 group-has-[:focus-visible]/code:pointer-events-auto group-has-[:focus-visible]/code:opacity-100"
        />
      ) : null}
    </div>
  )
}

function extractCodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractCodeText).join('')
  }
  if (React.isValidElement(node)) {
    return extractCodeText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}
