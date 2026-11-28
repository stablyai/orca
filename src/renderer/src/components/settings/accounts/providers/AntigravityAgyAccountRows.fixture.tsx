import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { AntigravityAccountState } from '../../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { AntigravityChatSignInControls } from '../../../provider-accounts/use-antigravity-chat-sign-in'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { AntigravityAgyAccountRows } from './AntigravityAgyAccountRows'

const saved = {
  id: 'saved',
  email: 'work@example.com',
  subject: 'work',
  authMethod: 'consumer',
  createdAt: Date.UTC(2026, 10, 20),
  updatedAt: Date.UTC(2026, 10, 20)
}
const personal = { ...saved, id: 'personal', email: 'personal@example.com', subject: 'personal' }

const loggedIn = (account: typeof saved) => ({
  email: account.email,
  subject: account.subject,
  authMethod: 'consumer',
  identityKnown: true
})

function signInControls(
  overrides: Partial<AntigravityChatSignInControls> = {}
): AntigravityChatSignInControls {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fixture stub with only the controls these rows read.
  return {
    ownFlow: false,
    alert: null,
    pending: false,
    signInDisabled: false,
    url: null,
    line: 'Waiting for you to finish signing in with Google…',
    copy: { status: 'idle', copy: () => {} },
    copyLabel: 'Copy sign-in link',
    start: () => {},
    addAccount: () => {},
    cancel: () => {},
    send: () => {},
    ...overrides
  } as unknown as AntigravityChatSignInControls
}

function rows(
  state: AntigravityAccountState | null,
  options: {
    error?: string | null
    windowsHost?: boolean
    signIn?: AntigravityChatSignInControls
  } = {}
): React.JSX.Element {
  return (
    <div className="bg-background p-6">
      <SettingsGroup title="Antigravity">
        <AntigravityAgyAccountRows
          state={state}
          error={options.error ?? null}
          busy={false}
          windowsHost={options.windowsHost ?? false}
          run={() => {}}
          {...(options.signIn ? { signIn: options.signIn } : {})}
        />
      </SettingsGroup>
    </div>
  )
}

const width = 720

export const loading = defineFixture({ width, render: () => rows(null) })

// Even the attribute read got no answer, so nothing could be listed.
export const keychainDidNotAnswer = defineFixture({
  width,
  render: () => rows(null, { error: "The keychain didn't answer. Unlock it and try again." })
})

// A WSL distro, where Orca can't run agy's sign-in.
export const notSignedInTerminal = defineFixture({
  width,
  render: () =>
    rows({ accounts: [], activeAccountId: null, selectedAccountId: null, currentAccount: null })
})

export const notSignedIn = defineFixture({
  width,
  render: () =>
    rows(
      { accounts: [], activeAccountId: null, selectedAccountId: null, currentAccount: null },
      { signIn: signInControls() }
    )
})

export const notSignedInSignInFailed = defineFixture({
  width,
  render: () =>
    rows(
      { accounts: [saved], activeAccountId: null, selectedAccountId: null, currentAccount: null },
      { signIn: signInControls({ alert: 'Sign-in failed. Try again.' }) }
    )
})

export const signingIn = defineFixture({
  width,
  render: () =>
    rows(
      { accounts: [saved], activeAccountId: null, selectedAccountId: null, currentAccount: null },
      { signIn: signInControls({ ownFlow: true }) }
    )
})

export const currentLoginNotSaved = defineFixture({
  width,
  render: () =>
    rows(
      {
        accounts: [saved],
        activeAccountId: null,
        selectedAccountId: null,
        currentAccount: loggedIn(personal)
      },
      { signIn: signInControls() }
    )
})

export const currentLoginWithoutEmail = defineFixture({
  width,
  render: () =>
    rows({
      accounts: [],
      activeAccountId: null,
      selectedAccountId: null,
      currentAccount: { email: null, subject: null, authMethod: 'consumer', identityKnown: true }
    })
})

export const selectedAccountActive = defineFixture({
  width,
  render: () =>
    rows(
      {
        accounts: [saved, personal],
        activeAccountId: saved.id,
        selectedAccountId: saved.id,
        currentAccount: loggedIn(saved)
      },
      { signIn: signInControls() }
    )
})

export const selectedAccountActiveTerminal = defineFixture({
  width,
  render: () =>
    rows({
      accounts: [saved, personal],
      activeAccountId: saved.id,
      selectedAccountId: saved.id,
      currentAccount: loggedIn(saved)
    })
})

export const addAccountFailed = defineFixture({
  width,
  render: () =>
    rows(
      {
        accounts: [saved],
        activeAccountId: saved.id,
        selectedAccountId: saved.id,
        currentAccount: loggedIn(saved)
      },
      { signIn: signInControls({ alert: 'Sign-in failed. Try again.' }) }
    )
})

export const otherSavedAccountHoldsLogin = defineFixture({
  width,
  render: () =>
    rows({
      accounts: [saved, personal],
      activeAccountId: personal.id,
      selectedAccountId: saved.id,
      restoresSelectionAtLaunch: true,
      currentAccount: loggedIn(personal)
    })
})

export const selectedAccountSignedOutByAgy = defineFixture({
  width,
  render: () =>
    rows({
      accounts: [saved],
      activeAccountId: null,
      selectedAccountId: saved.id,
      currentAccount: loggedIn(personal)
    })
})

export const windowsHostDefaultChanged = defineFixture({
  width,
  render: () =>
    rows(
      {
        accounts: [saved],
        activeAccountId: null,
        selectedAccountId: saved.id,
        currentAccount: null
      },
      { windowsHost: true, signIn: signInControls() }
    )
})

const unread: AntigravityAccountState = {
  accounts: [saved, personal],
  activeAccountId: null,
  selectedAccountId: saved.id,
  currentAccount: { email: null, subject: null, authMethod: '', identityKnown: false, unread: true }
}

export const signedInUnread = defineFixture({
  width,
  render: () => rows({ ...unread, restoresSelectionAtLaunch: true }, { signIn: signInControls() })
})

// Show account, then Deny (or Cancel) in the keychain dialog.
export const keychainDenied = defineFixture({
  width,
  render: () =>
    rows(unread, {
      error:
        "Orca was denied access to agy's login in the keychain. Allow it when asked to show or switch accounts."
    })
})

// A narrow Settings pane truncates a long name and keeps its tag.
export const narrowWindow = defineFixture({
  width: 375,
  render: () =>
    rows(
      {
        accounts: [{ ...saved, email: 'someone.with.a.long.name@corporate-example.com' }, personal],
        activeAccountId: saved.id,
        selectedAccountId: saved.id,
        currentAccount: loggedIn(saved)
      },
      { signIn: signInControls() }
    )
})
