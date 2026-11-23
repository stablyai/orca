import { runP4, type P4CommandResult } from './p4-command'
import { currentPerforceSettings } from './p4-settings-context'
import { parseTaggedOutput } from './p4-tagged-output'
import { peekWorkspaceScan, scanWorkspace } from './perforce-workspace-scan'

/** What the unopened-files preview found: a scan result, null while the first scan runs, or skipped. */
export type UnopenedPreview = P4CommandResult | null | 'sparse-stream'

async function isSparseStream(cwd: string, stream: string): Promise<boolean> {
  const result = await runP4(['-ztag', 'stream', '-o', stream], { cwd })
  const type = result.code === 0 ? parseTaggedOutput(result.stdout)[0]?.Type : undefined
  return type === 'sparsedev' || type === 'sparserel'
}

/**
 * Previews unopened changes; skipped entirely when the user hides both unopened sections. Null while
 * the folder's first scan runs, unless asked to wait for it.
 */
async function runReconcilePreview(
  cwd: string,
  waitForFirst: boolean
): Promise<P4CommandResult | null> {
  const settings = currentPerforceSettings()
  const flags = [
    ...(settings.showNewFiles ? ['-a'] : []),
    // -m: skip the digest of files whose modification time matches the have list.
    ...(settings.showModifiedNotOpened ? ['-e', '-m', '-d'] : [])
  ]
  if (flags.length === 0) {
    return { code: 0, stdout: '', stderr: '' }
  }
  const run = (signal: AbortSignal) =>
    runP4(['-ztag', 'reconcile', '-n', ...flags, '...'], {
      cwd,
      signal,
      timeoutMs: settings.statusScanTimeoutSeconds * 1000
    })
  const minIntervalMs = settings.refreshIntervalSeconds * 500
  return waitForFirst
    ? scanWorkspace(cwd, minIntervalMs, run)
    : peekWorkspaceScan(cwd, minIntervalMs, run)
}

/**
 * Sparse streams are not scanned: reconcile resolves every file against the parent, one server round
 * trip each, so a Unity-sized copy ran past 15 minutes while holding the client lock. Only opened
 * files are listed there.
 */
export async function previewUnopenedFiles(
  cwd: string,
  stream: Promise<string | undefined>,
  waitForFirst: boolean
): Promise<UnopenedPreview> {
  const name = await stream
  if (name && (await isSparseStream(cwd, name))) {
    return 'sparse-stream'
  }
  return runReconcilePreview(cwd, waitForFirst)
}
