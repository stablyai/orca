// @protected-copy: preserve code controls used by approval prompts.
import React, { useContext } from 'react'
import { WrapText } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { getCodeFenceLanguageLabel } from './code-fence-language-label'
import { NativeChatCopyButton } from '../../messages/actions/NativeChatCopyButton'
import { NativeChatMarkdownRowKeyContext } from '../native-chat-markdown-row-identity'
import { useNativeChatDisclosure } from '../../messages/disclosure/native-chat-disclosure-store'
import { NativeChatHighlightedCode } from './NativeChatHighlightedCode'
import { NativeChatHtmlPreview, NativeChatHtmlViewToggle } from './NativeChatHtmlPreview'
import { isHtmlDocumentCodeBlock } from '../../../../../../shared/markdown/html-document-fences'

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
  const t = useTranslate()
  const code = extractCodeText(children)
  const rowKey = useContext(NativeChatMarkdownRowKeyContext)
  // Keep wrap state in the transcript store so windowing and streaming block recuts cannot reset it; never persist it.
  const blockKey =
    rowKey === undefined || sourceLine === undefined ? undefined : `${rowKey}:${sourceLine}`
  const { open: wrapped, setOpen: setWrapped } = useNativeChatDisclosure(
    blockKey && `code-wrap:${blockKey}`,
    false
  )
  const htmlDocument = !plain && isHtmlDocumentCodeBlock(language, code)
  const { open: previewOpen, setOpen: setPreviewing } = useNativeChatDisclosure(
    blockKey && `code-preview:${blockKey}`,
    false
  )
  const previewing = htmlDocument && previewOpen
  const actions = code ? (
    <>
      <NativeChatCodeWrapButton wrapped={wrapped} onToggle={() => setWrapped(!wrapped)} />
      <NativeChatCopyButton
        platformLineEndings
        text={code}
        label={t('components.native-chat.copyCode', 'Copy code')}
      />
    </>
  ) : null

  return (
    <div
      data-native-chat-code-block={code ? '' : undefined}
      className="group/code relative my-3 min-w-0 max-w-full overflow-hidden rounded-lg border border-chat-code-border bg-chat-code-surface"
    >
      {language ? (
        <div
          className={cn(
            'flex items-center justify-between px-3',
            htmlDocument ? 'h-8.5 gap-2' : 'h-7.5'
          )}
        >
          {htmlDocument ? (
            <NativeChatHtmlViewToggle previewing={previewing} onChange={setPreviewing} />
          ) : (
            <span
              data-code-language={language}
              className="min-w-0 font-sans text-xs text-chat-foreground-faint"
            >
              <span className="truncate">{getCodeFenceLanguageLabel(language)}</span>
            </span>
          )}
          {code ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
        </div>
      ) : null}
      {previewing ? <NativeChatHtmlPreview code={code} /> : null}
      <pre
        data-native-chat-code-content
        hidden={previewing}
        className={cn(
          'scrollbar-sleek m-0 max-w-full font-mono text-chat-code text-chat-code-foreground',
          wrapped ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'overflow-x-auto',
          // Margin, not padding: overflowing text scrolls under padding, so only a margin keeps it out from under the actions.
          htmlDocument ? 'px-3 pt-0.5 pb-3' : language ? 'px-3.5 pt-0.5 pb-3' : 'mr-17 p-3 pr-1.5'
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
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-100 transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover/code:pointer-events-auto group-hover/code:opacity-100 [[class~='group/code']:has(:focus-visible)_&]:pointer-events-auto [[class~='group/code']:has(:focus-visible)_&]:opacity-100">
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
  const t = useTranslate()
  const label = wrapped
    ? t('components.native-chat.disableLineWrap', 'Disable line wrap')
    : t('components.native-chat.wrapLines', 'Wrap lines')
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
