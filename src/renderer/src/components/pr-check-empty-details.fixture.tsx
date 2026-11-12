import { defineFixture } from '../component-fixtures/component-fixture'
import { PRCheckEmptyDetails } from './pr-check-empty-details'
import { ChecksCompactHeader } from './pull-request-page/checks/toolbar'
import { ChecksTabCompactHeader } from './github-item-dialog/inspect-pull-request/checks-tab-header'
import { getChecksTabSummaryPresentation } from './github-item-dialog/inspect-pull-request/checks-tab-summary'
import { getOverallCheckCounts, getChecksSummaryLabel } from './pr-check-counts'
import { acceptPRCheckObservation } from '../../../shared/github/complete-pr-check-owner'
import { Button } from './ui/button'

const owner = acceptPRCheckObservation(
  {
    number: 42,
    url: 'https://github.com/acme/widgets/pull/42',
    headSha: 'h1',
    mergeable: 'UNKNOWN' as const
  },
  null,
  { scope: 'fixture', complete: true, current: true }
)!
function EmptyChecks({
  variant,
  dialog = false
}: {
  variant: 'page' | 'compact'
  dialog?: boolean
}) {
  const counts = getOverallCheckCounts([], owner)
  const presentation = getChecksTabSummaryPresentation(counts)
  const summaryLabel = getChecksSummaryLabel([], owner)
  const Header = dialog ? ChecksTabCompactHeader : ChecksCompactHeader
  const action = (
    <Button variant="outline" size="xs">
      Refresh
    </Button>
  )
  return (
    <div className="bg-background text-foreground">
      <PRCheckEmptyDetails
        dialog={dialog}
        owner={owner}
        variant={variant}
        {...presentation}
        summaryLabel={summaryLabel}
        actions={action}
        compactHeader={
          <Header
            {...presentation}
            counts={counts}
            showSummary
            summaryLabel={summaryLabel}
            listLength={0}
            refreshAction={action}
            rerunAction={null}
            secondaryActions={null}
          />
        }
      />
    </div>
  )
}
export const page = defineFixture({ width: 720, render: () => <EmptyChecks variant="page" /> })
export const compact = defineFixture({
  width: 305,
  render: () => <EmptyChecks variant="compact" />
})
export const dialog = defineFixture({
  width: 420,
  render: () => <EmptyChecks variant="compact" dialog />
})
