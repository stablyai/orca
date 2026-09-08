import type { MobileWebBridgeErrorCode } from './bridge-contract'

export class MobileWebBrokerError extends Error {
  constructor(readonly code: MobileWebBridgeErrorCode) {
    super(code)
  }
}
