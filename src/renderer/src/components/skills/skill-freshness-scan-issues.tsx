import type { SkillFreshnessScanIssue } from '../../../../shared/skill-freshness'
import { translate } from '@/i18n/i18n'

function issueDescription(issue: SkillFreshnessScanIssue): string {
  switch (issue.reason) {
    case 'depth-limit':
      return translate(
        'auto.components.skills.SkillFreshnessUpdateDialog.scanDepthLimit',
        'Orca reached its plugin scan depth limit before checking this folder.'
      )
    case 'entry-limit':
      return translate(
        'auto.components.skills.SkillFreshnessUpdateDialog.scanEntryLimit',
        'Orca reached its plugin scan entry limit before checking the rest of this cache.'
      )
    case 'candidate-limit':
      return translate(
        'auto.components.skills.SkillFreshnessUpdateDialog.scanCandidateLimit',
        'Orca found more same-named skill folders than it can safely inspect.'
      )
    case 'manifest-limit':
      return translate(
        'auto.components.skills.SkillFreshnessUpdateDialog.scanManifestLimit',
        'Orca skipped this plugin manifest because it exceeded a safe limit.'
      )
    case 'outside-root':
      return translate(
        'auto.components.skills.SkillFreshnessUpdateDialog.scanOutsideRoot',
        'Orca skipped this plugin path because it points outside the plugin cache.'
      )
    case 'io-error':
      return issue.errorCode
        ? translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.scanIoErrorWithCode',
            'Orca could not read this plugin path ({{value0}}).',
            { value0: issue.errorCode }
          )
        : translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.scanIoError',
            'Orca could not read this plugin path.'
          )
    case 'issue-limit':
      return translate(
        'auto.components.skills.SkillFreshnessUpdateDialog.scanIssueLimit',
        'Orca found too many skipped plugin folders to list individually.'
      )
  }
}

export function SkillFreshnessScanIssues({
  issues
}: {
  issues: readonly SkillFreshnessScanIssue[]
}): React.JSX.Element {
  return (
    <>
      {issues.map((issue) => (
        <div
          key={`${issue.rootId}\0${issue.path}\0${issue.reason}`}
          className="space-y-1.5 py-3 first:pt-0 last:pb-0"
        >
          <p className="text-sm font-medium text-foreground">{issue.sourceLabel}</p>
          <p className="text-xs leading-5 text-muted-foreground">{issueDescription(issue)}</p>
          <span
            className="block truncate font-mono text-[11px] text-muted-foreground"
            title={issue.path}
          >
            {issue.path}
          </span>
        </div>
      ))}
    </>
  )
}
