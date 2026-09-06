import { z } from 'zod'

const RemoteAvatarUrlSchema = z.string().url().max(4_096)

export const MobileWebHostedNullableAvatarUrlSchema = RemoteAvatarUrlSchema.nullable()
  .optional()
  .transform((): null => null)

export const MobileWebHostedOptionalAvatarUrlSchema = RemoteAvatarUrlSchema.optional().transform(
  (): undefined => undefined
)
