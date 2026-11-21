import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatPaneHeader } from './pane/actions/NativeChatPaneHeader'
import { link, source, partner, report } from './session-link-ui.test-fixture'
import {
  SessionLinkSnapshot,
  SESSION_LINK_CAPABILITY,
  SESSION_LINK_POLICY_CAPABILITY
} from '../../../../shared/session-link'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'

const rows = [
  { id: 'unlinked', label: 'No link · active pane', focused: true },
  { id: 'hidden', label: 'No link · inactive pane', focused: false },
  { id: 'active', label: 'Active link · inactive pane', focused: false },
  { id: 'waiting', label: 'Waiting for partner · inactive pane', focused: false },
  { id: 'question', label: 'Question for you · inactive pane', focused: false },
  { id: 'paused', label: 'Paused · inactive pane', focused: false },
  { id: 'limit', label: 'Turn limit reached · inactive pane', focused: false }
] as const

export const states = defineFixture({
  width: 800,
  setup: () => {
    setLocalRuntimeCapabilitiesForTests([SESSION_LINK_CAPABILITY, SESSION_LINK_POLICY_CAPABILITY])
    const snapshots = new Map(
      rows.map((row) => {
        const sessionId = `codex-checkout-${row.id}`
        return [
          sessionId,
          row.id === 'unlinked' || row.id === 'hidden'
            ? null
            : SessionLinkSnapshot.parse({
                link: {
                  ...link,
                  id: `checkout-${row.id}`,
                  participants: [
                    { ...source, sessionId, conversationId: sessionId },
                    { ...partner, name: '@"/projects/acme/review/a-long-session-name"' }
                  ],
                  policy: { turnLimit: 20 },
                  turns: row.id === 'limit' ? 20 : 3,
                  state:
                    row.id === 'question' || row.id === 'paused' || row.id === 'limit'
                      ? 'paused'
                      : 'active',
                  reason:
                    row.id === 'question'
                      ? 'owner-decision'
                      : row.id === 'paused'
                        ? 'pause'
                        : row.id === 'limit'
                          ? 'turn-limit'
                          : ''
                },
                events:
                  row.id === 'waiting'
                    ? [{ ...report, actor: sessionId }]
                    : row.id === 'question'
                      ? [
                          {
                            ...report,
                            kind: 'owner-request',
                            actor: partner.sessionId,
                            recipient: null,
                            state: 'recorded'
                          }
                        ]
                      : []
              })
        ]
      })
    )
    window.api.runtime.call = async (request) => {
      const params = request.params
      const sessionId =
        typeof params === 'object' &&
        params !== null &&
        'sessionId' in params &&
        typeof params.sessionId === 'string'
          ? params.sessionId
          : ''
      return {
        id: 'fixture',
        ok: true,
        _meta: { runtimeId: 'fixture' },
        result: snapshots.get(sessionId) ?? null
      }
    }
  },
  render: () => (
    <div className="space-y-3 bg-background p-4">
      {rows.map((row) => (
        <section key={row.id}>
          <p className="mb-1 text-xs text-muted-foreground">{row.label}</p>
          <div
            data-fixture-link-state={row.id}
            className="native-chat-appearance relative h-16 overflow-hidden rounded-md border bg-chat-pane"
          >
            <NativeChatPaneHeader
              tabId={`chat-${row.id}`}
              worktreeId="app"
              groupId="checkout-group"
              nativeChat={{ sessionId: `codex-checkout-${row.id}`, agent: 'codex' }}
              target={{ kind: 'local' }}
              focused={row.focused}
              colorScheme={undefined}
            />
            <p role="status" className="px-3 py-1 text-sm text-chat-foreground-faint">
              System: Offline checks finished. Review the checkout report before continuing with the
              next implementation step.
            </p>
          </div>
        </section>
      ))}
    </div>
  ),
  interact: async (frame) => {
    for (let i = 0; i < 60; i++) {
      const settled = rows.every((row) => {
        const pane = frame.querySelector(`[data-fixture-link-state="${row.id}"]`)
        const trigger = pane?.querySelector(
          'button[aria-label^="Linked with"], button[aria-label="Work together"]'
        )
        return trigger && getComputedStyle(trigger).opacity === (row.id === 'hidden' ? '0' : '1')
      })
      if (settled) {
        break
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    for (const row of rows) {
      const pane = frame.querySelector(`[data-fixture-link-state="${row.id}"]`)
      const trigger = pane?.querySelector(
        'button[aria-label^="Linked with"], button[aria-label="Work together"]'
      )
      if (!trigger || getComputedStyle(trigger).opacity !== (row.id === 'hidden' ? '0' : '1')) {
        throw new Error(
          `Incorrect collaboration trigger visibility: ${row.id} (${trigger?.getAttribute('aria-label')}, ${trigger && getComputedStyle(trigger).opacity})`
        )
      }
      if (trigger.getAttribute('aria-label')?.includes('/projects/')) {
        throw new Error('Raw session name leaked into trigger label')
      }
    }
  }
})
