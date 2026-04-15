import { detectLanguage } from './language-detect'
import { joinPath } from './path'

/**
 * Creates an untitled markdown file on disk and returns the metadata
 * needed by the editor store's `openFile` action.
 *
 * Throws on permission errors or name-collision exhaustion so callers
 * can surface the failure instead of silently dropping it.
 */
export async function createUntitledMarkdownFile(
  worktreePath: string,
  worktreeId: string
): Promise<{
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  isUntitled: true
  mode: 'edit'
}> {
  const baseName = 'untitled'
  const ext = '.md'
  const MAX_ATTEMPTS = 100

  // Why: createFile uses the 'wx' flag, so pathExists is only a hint. Another
  // create can still win the race after our last probe, especially when the
  // user fires the shortcut repeatedly or two split groups create files at
  // nearly the same time. Retrying EEXIST keeps "New Markdown" advancing to
  // the next untitled-N name instead of surfacing a spurious error toast.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const fileName = attempt === 1 ? `${baseName}${ext}` : `${baseName}-${attempt}${ext}`
    const filePath = joinPath(worktreePath, fileName)

    if (await window.api.shell.pathExists(filePath)) {
      continue
    }

    try {
      await window.api.fs.createFile({ filePath })

      return {
        filePath,
        relativePath: fileName,
        worktreeId,
        language: detectLanguage(fileName),
        isUntitled: true,
        mode: 'edit'
      }
    } catch (err) {
      const isEexist =
        err instanceof Error && (err.message.includes('EEXIST') || err.message.includes('exists'))
      if (isEexist && attempt < MAX_ATTEMPTS) {
        continue
      }
      throw err
    }
  }

  throw new Error(`Unable to create untitled markdown file after ${MAX_ATTEMPTS} attempts.`)
}
