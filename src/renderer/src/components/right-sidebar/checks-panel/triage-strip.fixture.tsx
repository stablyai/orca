import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PRTriageStrip } from './triage-strip'
import { ChecksList } from './checks-list'

export const conflictsAndFailedChecks = defineFixture({
  width: 305,
  render: () => (
    <div className="bg-background text-foreground">
      <PRTriageStrip
        review={{ mergeable: 'CONFLICTING' }}
        checks={[
          { name: 'typecheck', status: 'completed', conclusion: 'failure', url: null },
          { name: 'package', status: 'completed', conclusion: 'failure', url: null },
          { name: 'package (windows)', status: 'completed', conclusion: 'failure', url: null },
          { name: 'PR checks passed', status: 'completed', conclusion: 'failure', url: null }
        ]}
        isResolvingConflictsWithAI={false}
        onResolveConflictsWithAI={() => {}}
        isFixingChecksWithAI={false}
        onFixChecksWithAI={() => {}}
      />
    </div>
  )
})

const cancellationChecks = [
  { name: 'build', status: 'completed', conclusion: 'success', url: null },
  { name: 'old run', status: 'completed', conclusion: 'cancelled', url: null }
] as const

export const cancelledChecks = defineFixture({
  width: 305,
  render: () => (
    <div className="bg-background text-foreground">
      <PRTriageStrip
        checks={[...cancellationChecks]}
        isResolvingConflictsWithAI={false}
        onResolveConflictsWithAI={() => {}}
        isFixingChecksWithAI={false}
        onFixChecksWithAI={() => {}}
      />
      <ChecksList
        checks={[...cancellationChecks]}
        checksLoading={false}
        checkDetailsContextKey="fixture:cancelled"
        onLoadCheckDetails={async () => null}
      />
    </div>
  )
})
