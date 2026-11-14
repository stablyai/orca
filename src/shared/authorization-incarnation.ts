/** A captured authority may be revoked, but never becomes valid again. */
export type AuthorizationIncarnation = Readonly<{ id: string; signal: AbortSignal }>
