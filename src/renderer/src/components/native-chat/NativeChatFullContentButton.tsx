import { useCallback, useState } from 'react'
import { Expand } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { NativeChatClippedPayload } from '../../../../shared/native-chat-types'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { useNativeChatPayloadReader } from './native-chat-payload-reader'

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; text: string }
  | { kind: 'failed'; code: string }

/** The host's own refusal code. `RuntimeRpcCallError` carries it beside the
 *  prose message, so the message itself is never the code. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error) {
    const code = error.code
    if (typeof code === 'string' && /^[a-z][a-z_]*$/.test(code)) {
      return code
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return /^[a-z][a-z_]*$/.test(message) ? message : 'payload_read_failed'
}

/**
 * Offers the complete original of a clipped block when the host retained it.
 * Renders nothing when the block is not retrievable or no reader is in scope,
 * so the bounded head is never dressed up as the whole content.
 */
export function NativeChatFullContentButton({
  clipped,
  title
}: {
  clipped: NativeChatClippedPayload | undefined
  title: string
}): React.JSX.Element | null {
  const reader = useNativeChatPayloadReader()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LoadState>({ kind: 'idle' })

  const load = useCallback(async () => {
    if (!reader || !clipped) {
      return
    }
    setState({ kind: 'loading' })
    try {
      const text = await reader.readFullPayload(clipped.digest, clipped.byteLength)
      setState({ kind: 'loaded', text })
    } catch (error) {
      setState({ kind: 'failed', code: errorCode(error) })
    }
  }, [reader, clipped])

  if (!reader || !clipped?.retrievable) {
    return null
  }

  const label = translate('components.native-chat.fullContent.show', 'Show full content')
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => {
          setOpen(true)
          // A failed read is retried on the next open: a transient transport
          // error must not look permanent until the row unmounts.
          if (state.kind === 'idle' || state.kind === 'failed') {
            void load()
          }
        }}
        aria-label={label}
      >
        <Expand className="size-3" />
        {label}
        <span className="font-mono text-[10px] opacity-70">{clipped.byteLength} B</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {translate(
                'components.native-chat.fullContent.description',
                'Complete original retained by the execution host and verified against its digest.'
              )}{' '}
              <span className="font-mono text-[11px]">{clipped.digest.slice(0, 12)}</span>
            </DialogDescription>
          </DialogHeader>
          {state.kind === 'loaded' ? (
            <>
              <div className="flex justify-end">
                <NativeChatCopyButton
                  text={state.text}
                  label={translate('components.native-chat.fullContent.copy', 'Copy full content')}
                />
              </div>
              <pre
                data-testid="native-chat-full-content"
                className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] text-foreground/80 scrollbar-sleek"
              >
                {state.text}
              </pre>
            </>
          ) : state.kind === 'failed' ? (
            <p role="alert" className="text-sm text-destructive">
              {translate(
                'components.native-chat.fullContent.failed',
                'The full content could not be retrieved; only the clipped head is available.'
              )}{' '}
              <span className="font-mono text-[11px]">{state.code}</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {translate('components.native-chat.fullContent.loading', 'Retrieving…')}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
