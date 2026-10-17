import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { getRemoteFileArgs, withSshMutationExpectation } from '@/runtime/runtime-file-routing'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { OpenFile } from '@/store/slices/editor'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  FORMAT_ON_SAVE_TIMEOUT_MS,
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

type MaybeFormatSavedFileArgs = {
  file: OpenFile
  worktree: Worktree | null | undefined
  fileContext: RuntimeFileOperationArgs
  savedContent: string
}

// Why: the server's own formatter timeout plus room for the round trip, so a slow run is reported
// by the server rather than cut off by the transport.
const FORMAT_ON_SAVE_RPC_TIMEOUT_MS = FORMAT_ON_SAVE_TIMEOUT_MS + 10_000

/** Whether a save can reach a formatter at all: local files via IPC, remote files via their server. */
export function canFormatSavedFile(
  _file: Pick<OpenFile, 'runtimeEnvironmentId'>,
  worktree: Worktree | null | undefined
): boolean {
  return Boolean(worktree?.path)
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
    runFormat: (args) => runFormatOnHost(fileContext, args),
    readSavedContent: async () => {
      const result = await readRuntimeFileContent({
        target: fileContext.target,
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        // Why: the file lives on the host that ran the formatter; a local read would miss it.
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

/**
 * The host that owns the file runs the formatter: a remote workspace goes to its own server, never
 * to this machine's shell. An older server without the method means "not supported", not a failure.
 */
async function runFormatOnHost(
  fileContext: RuntimeFileOperationArgs,
  args: { repoId: string; worktreePath: string; filePath: string }
): Promise<FormatOnSaveResult> {
  const remoteArgs = getRemoteFileArgs(fileContext, args.filePath)
  if (!remoteArgs) {
    return window.api.editor.formatOnSave(args)
  }
  try {
    return await callRuntimeRpc<FormatOnSaveResult>(
      remoteArgs.target,
      'files.formatOnSave',
      withSshMutationExpectation(fileContext, {
        worktree: remoteArgs.worktreeSelector,
        relativePath: remoteArgs.relativePath
      }),
      { timeoutMs: FORMAT_ON_SAVE_RPC_TIMEOUT_MS }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return { status: 'skipped', reason: 'unsupported-host' }
    }
    // Why: a timeout or dropped transport proves nothing about the formatter on the host, so the
    // caller rereads the file instead of reporting a failure.
    throw error
  }
}
