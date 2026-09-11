import { BrowserTarget, requiredString } from './rpc-param-primitives'

export const CertificateProceed = BrowserTarget.extend({
  challengeId: requiredString('Missing required challengeId')
})
