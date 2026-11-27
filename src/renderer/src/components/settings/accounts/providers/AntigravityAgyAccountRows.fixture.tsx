import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { AntigravityAccountState } from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { AntigravityAgyAccountRows } from './AntigravityAgyAccountRows'

const saved = {
  id: 'saved',
  email: 'work@example.com',
  subject: 'work',
  authMethod: 'consumer',
  createdAt: 0,
  updatedAt: 0
}

function rows(state: AntigravityAccountState): React.JSX.Element {
  return (
    <div className="bg-background px-5">
      <AntigravityAgyAccountRows
        state={state}
        error={null}
        busy={false}
        windowsHost={false}
        run={() => {}}
      />
    </div>
  )
}

export const selectedAccountSignedOutByAgy = defineFixture({
  width: 640,
  render: () =>
    rows({
      accounts: [saved],
      activeAccountId: null,
      selectedAccountId: saved.id,
      currentAccount: {
        email: 'personal@example.com',
        subject: 'personal',
        authMethod: 'consumer',
        identityKnown: true
      }
    })
})

export const selectedAccountActive = defineFixture({
  width: 640,
  render: () =>
    rows({
      accounts: [saved],
      activeAccountId: saved.id,
      selectedAccountId: saved.id,
      currentAccount: {
        email: saved.email,
        subject: saved.subject,
        authMethod: 'consumer',
        identityKnown: true
      }
    })
})
