import { useEffect, useState } from 'react'
import type { FileLinkTarget } from '../terminal-file-link-target'
import { TerminalFilePeekBody } from './TerminalFilePeekBody'
import { loadTerminalFilePeek } from './terminal-file-peek-content'
import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'

export function TerminalLinkFilePreview({
  target
}: {
  target: FileLinkTarget
}): React.JSX.Element | null {
  const [result, setResult] = useState<{
    target: FileLinkTarget
    content: TerminalFilePeekContent | null
  } | null>(null)
  const content = result?.target === target ? result.content : 'loading'

  useEffect(() => {
    const controller = new AbortController()
    void loadTerminalFilePeek(target, controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) {
          setResult({ target, content: loaded })
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResult({
            target,
            content: { kind: 'notice', path: target.absolutePath, reason: 'unreadable' }
          })
        }
      })
    return () => controller.abort()
  }, [target])

  return content === null ? null : (
    <TerminalFilePeekBody content={content} fileContext={target.fileContext} />
  )
}
