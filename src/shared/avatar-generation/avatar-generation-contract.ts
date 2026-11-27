// Generating an avatar with an image-capable agent the user already has installed and signed in.

/** Agents whose CLI can save a generated image without a prompt, in preference order. */
export const AVATAR_IMAGE_AGENTS = ['codex', 'grok'] as const
export type AvatarImageAgent = (typeof AVATAR_IMAGE_AGENTS)[number]

export type AvatarImageAgentStatus = { agent: AvatarImageAgent; status: 'ready' | 'signed-out' }

/** Installed agents that can make images, in preference order; empty hides Generate. */
export type AvatarGenerationCapability = { agents: AvatarImageAgentStatus[] }

export type AvatarGenerationFailure =
  | 'unavailable'
  | 'signed-out'
  | 'usage-limit'
  | 'no-image'
  | 'timed-out'
  | 'failed'
  | 'canceled'

export type GeneratedAvatarImage = { mimeType: string; base64: string }

export type AvatarGenerationResult =
  | { ok: true; agent: AvatarImageAgent; image: GeneratedAvatarImage }
  | { ok: false; error: AvatarGenerationFailure; agent?: AvatarImageAgent }

export const MAX_AVATAR_DESCRIPTION_CHARS = 500

export type AvatarGenerationApi = {
  capability: () => Promise<AvatarGenerationCapability>
  generate: (args: {
    requestId: string
    description: string
    agent: AvatarImageAgent
  }) => Promise<AvatarGenerationResult>
  cancel: (args: { requestId: string }) => Promise<void>
}
