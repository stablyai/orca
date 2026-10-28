import { defineFixture } from '../../../component-fixtures/component-fixture'
import { TaskPageJiraIssueCount } from './IssueCount'

function Header({ shown, loaded, limit }: { shown: number; loaded: number; limit: number }) {
  return (
    <div className="flex items-center gap-2 bg-background p-3 text-2xs text-muted-foreground">
      <TaskPageJiraIssueCount shown={shown} loaded={loaded} limit={limit} />
    </div>
  )
}

export const belowLimit = defineFixture({
  width: 520,
  render: () => <Header shown={230} loaded={230} limit={1000} />
})

export const atLimit = defineFixture({
  width: 520,
  render: () => <Header shown={1000} loaded={1000} limit={1000} />
})
