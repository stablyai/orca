import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AgentSessionHooks } from '../../../../../shared/agent-session/agent-session-hooks'
import NativeChatHooksDialog from './NativeChatHooksDialog'

const listing: AgentSessionHooks = {
  scope: 'review-scope',
  cwd: '/workspace/project',
  live: true,
  warnings: [],
  hooks: [
    {
      key: 'project-pre-tool',
      currentHash: 'sha256:reviewed-command',
      handlerType: 'command',
      command: 'node ./scripts/check-tool-permissions.mjs --workspace "$PWD"',
      eventName: 'preToolUse',
      matcher: 'exec_command',
      source: 'project',
      sourcePath: '/workspace/project/.codex/hooks.json',
      enabled: true,
      isManaged: false,
      trustStatus: 'untrusted',
      timeoutSec: 10,
      async: false
    }
  ]
}

export const needsReview = defineFixture({
  width: 720,
  store: {
    activeModal: 'chat-hooks',
    modalData: { sessionId: 'fixture-chat', target: { kind: 'local' } }
  },
  setup: () => {
    window.api.runtime.call = async () => ({
      id: 'fixture',
      ok: true,
      result: listing,
      _meta: { runtimeId: 'fixture' }
    })
  },
  render: () => <NativeChatHooksDialog />
})

export const trustedDisabled = defineFixture({
  ...needsReview,
  setup: () => {
    window.api.runtime.call = async () => ({
      id: 'fixture',
      ok: true,
      result: {
        ...listing,
        hooks: [{ ...listing.hooks[0], enabled: false, trustStatus: 'trusted' }]
      },
      _meta: { runtimeId: 'fixture' }
    })
  }
})
