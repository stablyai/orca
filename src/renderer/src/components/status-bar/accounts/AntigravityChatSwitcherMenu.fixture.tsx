import { defineFixture } from '../../../component-fixtures/component-fixture'
import type {
  AntigravityAccountState,
  AntigravityAccountSummary
} from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { AntigravityChatSwitcherMenu } from './AntigravityChatSwitcherMenu'

const account = (id: string, email: string | null): AntigravityAccountSummary => ({
  id,
  email,
  subject: `${id}-subject`,
  authMethod: 'consumer',
  createdAt: 1,
  updatedAt: 1
})

function fixture({ open, emails }: { open: boolean; emails: (string | null)[] }) {
  const accounts = emails.map((email, index) => account(`account-${index}`, email))
  const state: AntigravityAccountState = {
    accounts,
    activeAccountId: accounts[0]?.id ?? null,
    selectedAccountId: accounts[0]?.id ?? null,
    currentAccount: {
      email: accounts[0]?.email ?? null,
      subject: accounts[0]?.subject ?? null,
      authMethod: 'consumer',
      identityKnown: true
    }
  }
  return defineFixture({
    width: 360,
    setup: () => {
      window.api.runtime.call = async ({ method }) => ({
        id: 'antigravity-accounts',
        ok: true,
        _meta: { runtimeId: 'fixture' },
        result: method === 'accounts.antigravityList' ? state : null
      })
    },
    render: () => (
      <div className={`flex items-end bg-background p-3 ${open ? 'h-[260px]' : 'h-14'}`}>
        <AntigravityChatSwitcherMenu
          chatAction={{ target: { kind: 'local' }, canSwitch: async () => true }}
        />
      </div>
    ),
    interact: async (frame) => {
      if (!open) {
        return
      }
      // The trigger is enabled once the list loads.
      await new Promise((resolve) => setTimeout(resolve, 200))
      frame
        .querySelector<HTMLButtonElement>('button[aria-label]')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    }
  })
}

export const closed = fixture({ open: false, emails: ['alex@example.com', 'sam@example.com'] })
export const open = fixture({
  open: true,
  emails: ['alex@example.com', 'sam@example.com', 'jordan.lee.long-address@example.com']
})
export const openNoEmail = fixture({ open: true, emails: ['alex@example.com', null] })
export const oneAccount = fixture({ open: false, emails: ['alex@example.com'] })
