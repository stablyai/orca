// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WslMoveResultBody } from './WslMoveResultBody'

describe('the reset result', () => {
  // "Nothing was moved" with no reason left the user guessing.
  it('says why the move stopped', () => {
    const markup = renderToStaticMarkup(
      <WslMoveResultBody
        distro="Ubuntu"
        result={{
          outcome: 'reset',
          migrationId: 'm1',
          detail: 'orcad_migration_stage_failed:orcad_migration_dormant_focus_conflict:activeRepoId'
        }}
        blockers={[]}
        reload="idle"
        onReload={() => {}}
        onReview={() => {}}
        onClose={() => {}}
      />
    )
    expect(markup).toContain('Why it stopped: orcad_migration_stage_failed:')
  })
})
