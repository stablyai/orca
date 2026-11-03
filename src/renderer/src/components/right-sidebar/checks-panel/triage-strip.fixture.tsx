import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PRTriageStrip } from './triage-strip'

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
