import { translate } from '@/i18n/i18n'

export function TaskPageJiraIssueCount({
  shown,
  loaded,
  limit
}: {
  shown: number
  loaded: number
  limit: number
}) {
  return (
    <>
      <span>
        {shown} {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
      </span>
      {loaded >= limit ? (
        <span>
          {translate(
            'jira.issueList.limitReached',
            'Only the first {{count}} loaded. Narrow the query to see the rest.',
            { count: limit }
          )}
        </span>
      ) : null}
    </>
  )
}
