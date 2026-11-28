import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { AntigravityAccountState } from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  AntigravityAgyAccountRows,
  type AntigravityAccountError
} from './AntigravityAgyAccountRows'

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
  error: AntigravityAccountError | null = null
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
    rows(unread, {
      message:
        "Orca was denied access to agy's login in the keychain. Allow it when asked to show or switch accounts.",
      accountId: null
    })
})

// Even the attribute read got no answer, so nothing could be listed.
export const keychainDidNotAnswer = defineFixture({
  width: 640,
  render: () =>
    rows(null, { message: "The keychain didn't answer. Unlock it and try again.", accountId: null })
})

export const expiredLoginWithAdc = defineFixture({
  width: 640,
  render: () =>
    rows({
      accounts: [],
      activeAccountId: null,
      selectedAccountId: null,
      agyAdcAuth: true,
      currentAccount: {
        email: null,
        subject: null,
        authMethod: 'consumer',
        identityKnown: false,
        expiredAt: Date.UTC(2026, 10, 20, 6),
        cannotRefresh: true
      }
    })
})

const unsavedLogin = {
  email: 'personal@gmail.com',
  subject: 'personal',
  authMethod: 'consumer',
  identityKnown: true
}

export const expiredLogin = defineFixture({
  width: 640,
  render: () =>
    rows({
      accounts: [],
      activeAccountId: null,
      selectedAccountId: null,
      currentAccount: {
        email: null,
        subject: null,
        authMethod: 'consumer',
        identityKnown: false,
        expiredAt: Date.UTC(2026, 10, 20, 6),
        cannotRefresh: true
      }
    })
})

export const saveFailedOnCurrentLogin = defineFixture({
  width: 640,
  render: () =>
    rows(
      {
        accounts: [saved],
        activeAccountId: null,
        selectedAccountId: null,
        currentAccount: unsavedLogin
      },
      {
        message: 'Could not reach Google to identify the Antigravity account; nothing was saved.',
        accountId: null
      }
    )
})

export const adcWithSavedAccount = defineFixture({
  width: 640,
  render: () =>
    rows({
      accounts: [saved],
      activeAccountId: saved.id,
      selectedAccountId: saved.id,
      agyAdcAuth: true,
      currentAccount: {
        email: saved.email,
        subject: saved.subject,
        authMethod: 'consumer',
        identityKnown: true
      }
    })
})

export const savedLoginExpired = defineFixture({
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
        identityKnown: true,
        expiredAt: Date.UTC(2026, 10, 20, 6),
        cannotRefresh: true
      }
    })
})
