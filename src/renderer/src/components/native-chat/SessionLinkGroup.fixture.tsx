import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import {
  SESSION_LINK_CAPABILITY,
  SESSION_LINK_GROUP_CAPABILITY,
  SESSION_LINK_POLICY_CAPABILITY,
  SessionLinkParticipant
} from '../../../../shared/session-link'
import { SessionLinkControl } from './SessionLinkControl'
import { source, partner, link, report } from './session-link-ui.test-fixture'

const gemini = SessionLinkParticipant.parse({
  ...partner,
  sessionId: 'gemini-checkout',
  conversationId: 'gemini-checkout',
  agent: 'gemini',
  name: 'Checkout verification',
  directory: '/projects/acme/checks',
  workspaceId: 'checks',
  role: 'implementer',
  task: 'Verify checkout behavior and report results.'
})
function setup(group: boolean) {
  const settings = useAppStore.getState().settings
  if (settings) {
    useAppStore.setState({ settings: { ...settings, uiLanguage: 'en' } })
  }
  void i18n.changeLanguage('en')
  setLocalRuntimeCapabilitiesForTests([
    SESSION_LINK_CAPABILITY,
    SESSION_LINK_POLICY_CAPABILITY,
    SESSION_LINK_GROUP_CAPABILITY
  ])
  window.api.runtime.call = async (request) => ({
    id: 'fixture',
    ok: true,
    _meta: { runtimeId: 'fixture' },
    result:
      request.method === 'orchestration.linkCandidates'
        ? { source, candidates: group ? [] : [gemini], history: [] }
        : {
            link: {
              ...link,
              policy: { turnLimit: 20 },
              participants: group ? [source, partner, gemini] : [source, partner]
            },
            events: [report]
          }
  })
}
const render = () => (
  <SessionLinkControl sessionId={source.sessionId} target={{ kind: 'local' }} dialogOnly />
)
const renderAdd = () => (
  <SessionLinkControl
    sessionId={source.sessionId}
    target={{ kind: 'local' }}
    initialPartnerSessionId={gemini.sessionId}
    dialogOnly
  />
)
export const add390 = defineFixture({
  width: 390,
  setup: () => setup(false),
  render: renderAdd
})
export const add800 = defineFixture({
  width: 800,
  setup: () => setup(false),
  render: renderAdd
})
export const group390 = defineFixture({ width: 390, setup: () => setup(true), render })
export const group800 = defineFixture({ width: 800, setup: () => setup(true), render })
