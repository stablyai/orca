import React, { useState } from 'react'
import { WrapText } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  // Per block and not persisted: long lines scroll sideways until the reader asks to wrap.
  const [wrapped, setWrapped] = useState(false)
  const wrapButton = code ? (
    <NativeChatCodeWrapButton wrapped={wrapped} onToggle={() => setWrapped((value) => !value)} />
  ) : null
  const copyButton = code ? (
    <NativeChatCopyButton
      text={code}
      label={translate('components.native-chat.copyCode', 'Copy code')}
    />
  ) : null

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
            <div className="-mr-1 flex items-center gap-0.5 text-chat-foreground-faint">
              {wrapButton}
              {copyButton}
            </div>
          ) : null}
        </div>
      ) : null}
      <pre
        data-native-chat-code-content
        className={cn(
          'scrollbar-sleek m-0 max-w-full font-mono text-[12px] text-chat-code-foreground',
          wrapped ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'overflow-x-auto',
          language ? 'px-3.5 pt-0.5 pb-3' : 'p-3 pr-16'
        )}
      >
        {children}
      </pre>
      {code && !language ? (
        <div className="absolute right-2 top-2 flex items-center gap-0.5 text-chat-foreground-faint opacity-100 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover/code:pointer-events-auto group-hover/code:opacity-100 [[class~='group/code']:has(:focus-visible)_&]:pointer-events-auto [[class~='group/code']:has(:focus-visible)_&]:opacity-100">
          {wrapButton}
          {copyButton}
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={wrapped ? 'secondary' : 'ghost'}
          size="icon-xs"
          aria-label={label}
          aria-pressed={wrapped}
          onClick={onToggle}
        >
          <WrapText className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
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
