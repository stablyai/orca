import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import { translate } from '@/i18n/i18n'

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'gitignore':
      return translate('repoScan.reason.gitignore', 'Excluded by .gitignore')
    case 'builtin':
      return translate('repoScan.reason.builtin', 'Excluded by built-in directory policy')
    case 'hidden':
      return translate('repoScan.reason.hidden', 'Excluded by hidden-folder policy')
    case 'symlink':
      return translate('repoScan.reason.symlink', 'Symbolic link not followed')
    case 'depth-limit':
      return translate('repoScan.reason.depth', 'Contents below scan depth were not checked')
    case 'unreadable':
      return translate(
        'repoScan.reason.unreadable',
        'Folder could not be read; contents were not checked'
      )
    default:
      return translate('repoScan.reason.unknown', 'Exclusion details unavailable')
  }
}

export function NestedRepoScanExplanations({
  scan
}: {
  scan: NestedRepoScanResult
}): React.JSX.Element {
  const diagnostics = scan.diagnostics
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      {scan.selectedPathKind === 'git_repo' ? (
        <p>
          {translate(
            'repoScan.gitRoot',
            'This path is a Git repository. Nested repository scanning was skipped, so group import is not available for this selection.'
          )}
        </p>
      ) : null}
      {scan.stopped ? (
        <p>
          {translate(
            'repoScan.stopped',
            'Scan stopped by request. Showing repositories found so far.'
          )}
        </p>
      ) : null}
      {scan.timedOut ? (
        <p>
          {translate(
            'repoScan.timedOut',
            'Scan reached its time limit. Some folders were not checked.'
          )}
        </p>
      ) : null}
      {scan.truncated ? (
        <p>
          {translate(
            'repoScan.repoLimit',
            'Scan reached its repository limit. Some folders were not checked.'
          )}
        </p>
      ) : null}
      {diagnostics
        ? Object.entries(diagnostics.counts)
            .filter(([, count]) => count > 0)
            .map(([reason, count]) => (
              <p key={reason}>
                {reason === 'symlink'
                  ? translate('repoScan.linkCount', 'Links: {{count}}. {{reason}}', {
                      count,
                      reason: reasonLabel(reason)
                    })
                  : translate('repoScan.folderCount', 'Folders: {{count}}. {{reason}}', {
                      count,
                      reason: reasonLabel(reason)
                    })}
              </p>
            ))
        : null}
      {diagnostics && diagnostics.details.length > 0 ? (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-foreground">
            {translate('repoScan.showDetails', 'Show scan details')}
          </summary>
          <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto scrollbar-sleek">
            {diagnostics.details.map((detail, index) => (
              // oxlint-disable-next-line react-doctor/no-array-index-as-key -- Read-only snapshot rows have no state; shortened paths can collide.
              <li key={`${index}:${detail.path}`} className="space-y-1 break-all">
                <code>{detail.path}</code>
                <p>
                  {reasonLabel(detail.reason)}
                  {detail.errorCode ? ` (${detail.errorCode})` : ''}
                </p>
                {detail.ignoreFile && detail.rule ? (
                  <p>
                    <code>
                      {detail.ignoreFile}
                      {detail.line ? `:${detail.line}` : ''}
                    </code>
                    : <code>{detail.rule}</code>
                  </p>
                ) : null}
                {detail.shortened ? (
                  <p>{translate('repoScan.shortened', 'Long path or rule text was shortened.')}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {diagnostics.omittedDetails > 0 ? (
            <p className="mt-2">
              {translate('repoScan.omitted', '{{count}} additional details omitted.', {
                count: diagnostics.omittedDetails
              })}
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  )
}
