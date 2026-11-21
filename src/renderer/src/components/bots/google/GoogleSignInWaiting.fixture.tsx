import { defineFixture } from '../../../component-fixtures/component-fixture'
import { GoogleSignInWaiting } from './GoogleSignInWaiting'

const prompt = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture',
  redirectUri: 'http://127.0.0.1:41234/google/callback',
  expiresAt: 1,
  browserOpened: false
}

/** Web or phone: Google's page opened on this device; its address is pasted back to the server. */
export const webPaste = defineFixture({
  width: 372,
  render: () => (
    <GoogleSignInWaiting state={{ kind: 'waiting', prompt, way: 'paste' }} onCancel={() => {}} />
  )
})
