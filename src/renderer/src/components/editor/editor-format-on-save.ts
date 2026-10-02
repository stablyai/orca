import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { readRuntimeFileContent } from '@/runtime/runtime-file-client'
import type { OpenFile } from '@/store/slices/editor'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  isFormatOnSaveConfigured,
  matchesFormatOnSaveInclude,
  normalizeRepoFormatOnSaveSettings,
  type FormatOnSaveResult
} from '../../../../shared/format-on-save-command'
import type { Repo } from '../../../../shared/repo-types'

export type FormatSavedFileRequest = {
  repoId: string
  worktreePath: string
  filePath: string
  savedContent: string
  runFormat: (args: {
    repoId: string
    worktreePath: string
    filePath: string
  }) => Promise<FormatOnSaveResult>
  readSavedContent: () => Promise<string | null>
}

/**
 * Runs the repo's formatter over a file the editor just wrote, and returns the
 * reformatted text when the formatter actually changed it. `null` means the
 * buffer should keep the content it saved.
 */
export async function formatSavedFile({
  repoId,
  worktreePath,
  filePath,
  savedContent,
  runFormat,
  readSavedContent
}: FormatSavedFileRequest): Promise<string | null> {
  let result: FormatOnSaveResult
  try {
    result = await runFormat({ repoId, worktreePath, filePath })
  } catch (error) {
    // Why: the file is already on disk; a broken format channel must not turn a
    // successful save into a failed one. The outcome is unknown, so still reread.
    console.error('[editor] format on save failed', error)
    return readFormattedContent(readSavedContent, savedContent)
  }

  if (result.status === 'failed') {
    notifyFormatFailure(result.message)
    // Why: a formatter can write and then exit non-zero (a later lint step, a timeout kill),
    // so the disk bytes may no longer be the ones just saved.
    return readFormattedContent(readSavedContent, savedContent)
  }

  if (result.status !== 'completed') {
    return null
  }

  return readFormattedContent(readSavedContent, savedContent)
}

async function readFormattedContent(
  readSavedContent: () => Promise<string | null>,
  savedContent: string
): Promise<string | null> {
  try {
    const formatted = await readSavedContent()
    if (formatted === null || formatted === savedContent) {
      return null
    }
    return formatted
  } catch (error) {
    console.error('[editor] reading formatted file failed', error)
    return null
  }
}

// Why: mirrors the fields getEditorFileOperationContext returns that this path
// needs; typing `settings` off the file client keeps the read call cast-free.
type EditorFileOperationContext = {
  settings: Parameters<typeof readRuntimeFileContent>[0]['settings']
  worktreeId: string
  worktreePath: string | null
  connectionId?: string
  expectedExecutionHostId: 'local' | `ssh:${string}`
}

type MaybeFormatSavedFileArgs = {
  file: OpenFile
  worktree: Worktree | null | undefined
  fileContext: EditorFileOperationContext
  savedContent: string
}

/**
 * Whether a save can reach the formatter at all. Runtime environments have no
 * non-interactive exec channel, so they skip the IPC round trip; SSH-backed
 * repos do have one and are handled in the main process.
 */
export function canFormatSavedFile(
  file: Pick<OpenFile, 'runtimeEnvironmentId'>,
  worktree: Worktree | null | undefined
): boolean {
  return Boolean(worktree?.path) && !file.runtimeEnvironmentId
}

/** Whether the repo's own config says this save will run a formatter. */
export function willFormatSavedFile(
  file: Pick<OpenFile, 'runtimeEnvironmentId' | 'relativePath'>,
  worktree: Worktree | null | undefined,
  repo: Pick<Repo, 'formatOnSave'> | undefined
): boolean {
  if (!canFormatSavedFile(file, worktree)) {
    return false
  }
  const settings = normalizeRepoFormatOnSaveSettings(repo?.formatOnSave)
  return (
    isFormatOnSaveConfigured(settings) &&
    matchesFormatOnSaveInclude(file.relativePath, settings.include)
  )
}

/**
 * Editor-side entry point: decides whether this save is even formattable, then
 * defers to the main process, which owns the configured command.
 */
export async function maybeFormatSavedFile({
  file,
  worktree,
  fileContext,
  savedContent
}: MaybeFormatSavedFileArgs): Promise<string | null> {
  if (!worktree?.path || !canFormatSavedFile(file, worktree)) {
    return null
  }

  return formatSavedFile({
    repoId: worktree.repoId,
    worktreePath: worktree.path,
    filePath: file.filePath,
    savedContent,
    runFormat: (args) => window.api.editor.formatOnSave(args),
    readSavedContent: async () => {
      const result = await readRuntimeFileContent({
        settings: fileContext.settings,
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        // Why: an SSH file lives on the host that ran the formatter; a local read would miss it.
        connectionId: fileContext.connectionId
      })
      return typeof result.content === 'string' ? result.content : null
    }
  })
}

function notifyFormatFailure(message: string): void {
  toast.error(
    translate('auto.components.editor.formatOnSave.failure.notice.4f2b1c9a7d', 'Formatter failed'),
    {
      // Why: a formatter reports the offending line on stderr; truncate so a
      // stack-trace-sized failure cannot cover the workspace.
      description: message.length > 300 ? `${message.slice(0, 300)}…` : message
    }
  )
}
