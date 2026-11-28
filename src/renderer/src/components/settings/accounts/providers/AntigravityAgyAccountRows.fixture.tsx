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

function rows(
  state: AntigravityAccountState | null,
  error: string | null = null
): React.JSX.Element {
  return (
    <div className="bg-background px-5">
      <AntigravityAgyAccountRows
        state={state}
        error={error}
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

const personal = { ...saved, id: 'personal', email: 'personal@example.com', subject: 'personal' }

export const otherSavedAccountHoldsLogin = defineFixture({
  width: 640,
  render: () =>
    rows({
      accounts: [saved, personal],
      activeAccountId: personal.id,
      selectedAccountId: saved.id,
      restoresSelectionAtLaunch: true,
      currentAccount: {
        email: personal.email,
        subject: personal.subject,
        authMethod: 'consumer',
        identityKnown: true
      }
    })
})

const unread: AntigravityAccountState = {
  accounts: [saved, personal],
  activeAccountId: null,
  selectedAccountId: saved.id,
  currentAccount: { email: null, subject: null, authMethod: '', identityKnown: false, unread: true }
}

export const signedInUnread = defineFixture({
  width: 640,
  render: () => rows({ ...unread, restoresSelectionAtLaunch: true })
})

// Show account, then Deny (or Cancel) in the keychain dialog.
export const keychainDenied = defineFixture({
  width: 640,
  render: () =>
    rows(
      unread,
      "Orca was denied access to agy's login in the keychain. Allow it when asked to show or switch accounts."
    )
})

// Even the attribute read got no answer, so nothing could be listed.
export const keychainDidNotAnswer = defineFixture({
  width: 640,
  render: () => rows(null, "The keychain didn't answer. Unlock it and try again.")
})
