import { z } from 'zod'

/** The characters `wsl --import` accepts; the name is what `wsl.exe -d` takes. */
export const WslDistroNameSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9._-]+$/)

/** Lowercase unbraced Lxss registration GUID. Distro names can be reused; unregister/import changes this identity. */
export const WslDistroIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

const PortSchema = z.number().int().min(1).max(65_535)

/** A managed orcad Orca deployed into a WSL distro and reaches through a `wsl.exe` stdio bridge. */
export const OrcadWslDeploymentLinkSchema = z.object({
  kind: z.literal('wsl'),
  distro: WslDistroNameSchema,
  distroId: WslDistroIdSchema.optional(),
  /** The desktop loopback port the bridge listens on; the pairing endpoint points here. */
  localPort: PortSchema,
  /** orcad's listen port inside the distro, which each bridge connection dials. */
  remotePort: PortSchema
})

export type OrcadWslDeploymentLink = z.infer<typeof OrcadWslDeploymentLinkSchema>
