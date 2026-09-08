import { z } from 'zod'

/** How an operation touches host state. Mutations must reauthorize an opaque handle they
 * resolved before any await that precedes the host write. */
export type MobileWebBridgeOperationKind = 'read' | 'mutation' | 'subscription'

export const MOBILE_WEB_BRIDGE_OPERATIONS = {
  workspace: {
    hostSubscribe: 'subscription',
    hostRequest: 'mutation',
    snapshot: 'read',
    creationCreateBlank: 'mutation',
    creationCreateFromSource: 'mutation'
  },
  terminal: {
    subscribe: 'subscription',
    input: 'mutation',
    queryReply: 'mutation',
    clipboardPaste: 'mutation',
    attachImage: 'mutation',
    resize: 'mutation',
    visibility: 'mutation',
    resync: 'mutation',
    ack: 'mutation',
    cancel: 'mutation'
  },
  file: {
    markdownDraftRead: 'read',
    markdownDraftWrite: 'mutation'
  },
  sourceControl: {
    generateCommitMessage: 'mutation',
    cancelCommitMessageGeneration: 'mutation'
  },
  account: {
    resetCreditCapability: 'read',
    consumeResetCredit: 'mutation'
  },
  speech: {
    subscribe: 'subscription',
    start: 'mutation',
    stop: 'mutation',
    cancel: 'mutation'
  },
  native: {
    notificationPermission: 'mutation',
    notificationPreference: 'mutation',
    openSystemSettings: 'mutation',
    diagnosticsSnapshot: 'read',
    diagnosticsProbe: 'read',
    diagnosticsSubmit: 'mutation',
    alert: 'mutation',
    hapticSelection: 'mutation',
    hapticFeedback: 'mutation',
    clipboardAvailability: 'read',
    clipboardWrite: 'mutation',
    openExternal: 'mutation',
    pagePreferences: 'mutation',
    terminalPreferences: 'read',
    terminalAccessoryPreferences: 'read',
    terminalCustomKeysUpdate: 'mutation',
    terminalTextScaleUpdate: 'mutation',
    sessionChatDraftRead: 'read',
    sessionChatDraftWrite: 'mutation'
  },
  nativeChat: {
    attachImage: 'mutation',
    pasteImages: 'mutation',
    releaseImages: 'mutation',
    pendingRead: 'read',
    pendingWrite: 'mutation'
  },
  navigation: {
    route: 'mutation',
    reconnect: 'mutation',
    removeHost: 'mutation'
  }
} as const satisfies Record<string, Record<string, MobileWebBridgeOperationKind>>

/** Capability names come from the operation table so a capability cannot exist in one and not the
 * other. */
export type MobileWebBridgeCapability = keyof typeof MOBILE_WEB_BRIDGE_OPERATIONS

export const MobileWebBridgeCapabilitySchema = z.enum(
  Object.keys(MOBILE_WEB_BRIDGE_OPERATIONS) as [
    MobileWebBridgeCapability,
    ...MobileWebBridgeCapability[]
  ]
)

/** Operation names a page may request for one capability. Keeps request clients from naming an
 * operation the shell never granted. Distributes so the default parameter still spans every
 * capability instead of intersecting their key sets. */
export type MobileWebBridgeOperationName<
  TCapability extends MobileWebBridgeCapability = MobileWebBridgeCapability
> = TCapability extends MobileWebBridgeCapability
  ? keyof (typeof MOBILE_WEB_BRIDGE_OPERATIONS)[TCapability] & string
  : never

export function isMobileWebBridgeOperation(
  capability: MobileWebBridgeCapability,
  operation: string
): boolean {
  return Object.hasOwn(MOBILE_WEB_BRIDGE_OPERATIONS[capability], operation)
}
