import { useAppStore } from '@/store/index'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import { getEditorFileReadContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { readHostFilePreview } from '@/runtime/files/grants/runtime-terminal-artifact-read'

const TAIL_BYTES = 64 * 1024
const TAIL_LINES = 200
// The user picked this one task's output, so main may read it outside the project roots.
const USER_FILE = { kind: 'user-file' } as const

/** The last lines of text; a cut at `fromMiddle` drops the partial first line. */
export function zotzOutputTail(text: string, fromMiddle: boolean): string {
  const lines = text.split('\n')
  if (fromMiddle) {
    lines.shift()
  }
  return lines.slice(-TAIL_LINES).join('\n')
}

/** Reads the tail of a task's output file through the chat worktree's own host (local, SSH, WSL or a server). */
export async function readZotzTaskOutputTail(
  worktreeId: string,
  filePath: string
): Promise<string> {
  const context = getEditorFileReadContext(useAppStore.getState(), { worktreeId }, null)
  if (context.target.kind === 'environment') {
    const file = await readHostFilePreview({
      target: context.target,
      worktreeId,
      absolutePath: filePath
    })
    return zotzOutputTail(file.content, file.content.length > TAIL_BYTES)
  }
  const stat = await window.api.fs.stat({
    filePath,
    connectionId: context.connectionId,
    access: USER_FILE
  })
  const offset = Math.max(0, stat.size - TAIL_BYTES)
  if (stat.size <= offset) {
    return ''
  }
  const chunk = await window.api.fs.readFileChunk({
    filePath,
    connectionId: context.connectionId,
    access: USER_FILE,
    offset,
    length: stat.size - offset
  })
  return zotzOutputTail(
    new TextDecoder().decode(decodeBase64Bytes(chunk.contentBase64)),
    offset > 0
  )
}
