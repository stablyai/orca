import { defineFixture } from '../../component-fixtures/component-fixture'
import CommunityPage from './CommunityPage'
const setup = (): void => {
  const endpoint = new URLSearchParams(window.location.search).get('communityProofEndpoint')
  if (!endpoint) {
    return
  }
  const url = new URL(endpoint)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    !/^\/[a-f0-9-]{36}$/.test(url.pathname)
  ) {
    return
  }
  const original = window.api.runtime.call
  window.api.runtime.call = async (request) => {
    if (!request.method.startsWith('community.')) {
      return original(request)
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    })
    return response.json()
  }
}
export const desktop = defineFixture({
  width: 1440,
  setup,
  render: () => (
    <div className="h-[100dvh]">
      <CommunityPage />
    </div>
  )
})
export const phone = defineFixture({
  width: 390,
  setup,
  render: () => (
    <div className="h-[100dvh]">
      <CommunityPage />
    </div>
  )
})
