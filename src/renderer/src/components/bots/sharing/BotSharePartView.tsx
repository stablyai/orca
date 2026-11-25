// One part's exact text, as it goes out, with its flagged lines marked.
import { useEffect, useState } from 'react'
import { type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotSharePartFile } from '../../../../../shared/bots/bot-package'
import { botShareErrorMessage } from './bot-share-error-copy'
import { botShareFlagLabel } from './bot-share-flags'
import { viewBotSharePart } from './bot-share-rpc'
import { BotShareFlagNote } from './BotShareRows'

function NumberedText({
  text,
  flags
}: {
  text: string
  flags: BotSharePartFile['flags']
}): React.JSX.Element {
  const flagged = new Map(flags.map((flag) => [flag.line, flag.kind]))
  const lines = text.replace(/\n$/, '').split('\n')
  return (
    <pre className="scrollbar-sleek max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
      {lines.map((line, index) => {
        const kind = flagged.get(index + 1)
        return (
          <div key={index} className="flex gap-3">
            <span className="w-5 shrink-0 text-right text-muted-foreground select-none">
              {index + 1}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1',
                kind &&
                  (kind === 'secret'
                    ? 'rounded-sm ring-1 ring-destructive/70'
                    : 'rounded-sm ring-1 ring-status-warning-border')
              )}
            >
              {line || ' '}
            </span>
          </div>
        )
      })}
    </pre>
  )
}

function FileBody({ file }: { file: Pick<BotSharePartFile, 'text' | 'flags'> }): React.JSX.Element {
  const t = useTranslate()
  if (file.text === null) {
    return (
      <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
        {t('bots.share.binaryFile', 'Not text, so it isn’t shown.')}
      </p>
    )
  }
  const kinds = [...new Set(file.flags.map((flag) => flag.kind))]
  return (
    <>
      <NumberedText text={file.text} flags={file.flags} />
      {kinds.map((kind) => (
        <BotShareFlagNote key={kind} kind={kind === 'secret' ? 'secret' : 'warning'}>
          {botShareFlagLabel(kind)}
        </BotShareFlagNote>
      ))}
    </>
  )
}

/** The files of a part, read from what the candidate was built from. */
export function BotSharePartFiles({
  bot,
  candidateId,
  part,
  showNames
}: {
  bot: BotRef
  candidateId: string
  part: string
  showNames: boolean
}): React.JSX.Element {
  const ref = useStableBotRef(bot)
  const [files, setFiles] = useState<BotSharePartFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setFiles(null)
    setError(null)
    viewBotSharePart(ref, candidateId, part).then(
      (read) => current && setFiles(read),
      (cause: unknown) => current && setError(botShareErrorMessage(cause))
    )
    return () => {
      current = false
    }
  }, [ref, candidateId, part])

  if (error) {
    return (
      <p className="text-xs text-destructive" role="alert">
        {error}
      </p>
    )
  }
  if (!files) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  }
  return <BotShareFileList files={files} showNames={showNames} />
}

/** Files shown exactly as written, flagged lines marked; a file's name above it when asked. */
export function BotShareFileList({
  files,
  showNames
}: {
  files: readonly Pick<BotSharePartFile, 'path' | 'text' | 'flags'>[]
  showNames: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      {files.map((file) => (
        <div key={file.path} className="space-y-1.5">
          {showNames ? (
            <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
          ) : null}
          <FileBody file={file} />
        </div>
      ))}
    </div>
  )
}
