import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { getEnvironmentStorePath } from './runtime-environment-store-file'

// The environment schema v1.4.217 and v1.4.218 shipped: a plain z.object, so unknown keys are
// stripped, and every write (lastUsedAt included) rewrites the whole file.
const ShippedEnvironmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  pairingRevision: z.number().finite().optional(),
  pairedDeviceId: z.string().min(1).optional(),
  lastUsedAt: z.number().finite().nullable(),
  runtimeId: z.string().min(1).nullable(),
  source: z.enum(['manual', 'ephemeral-vm']).optional(),
  connectionDependency: z.literal('ssh-tunnel').optional(),
  endpoints: z.array(z.object({}).passthrough()).min(1),
  preferredEndpointId: z.string().min(1)
})
const ShippedStoreSchema = z.object({
  version: z.literal(1),
  environments: z.array(ShippedEnvironmentSchema)
})

/** Rewrites orca-environments.json the way a downgraded build does, stripping unknown keys. */
export function shippedBuildRewrite(
  userDataPath: string,
  edit: (environments: z.infer<typeof ShippedEnvironmentSchema>[]) => void = () => {}
): void {
  const path = getEnvironmentStorePath(userDataPath)
  const store = ShippedStoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  edit(store.environments)
  writeFileSync(path, JSON.stringify(store))
}
