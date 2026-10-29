/** Typed extension slots resolve dynamic plugin implementations without compile-time coupling. P0 points are experimental
 * and excluded from compatibility guarantees. */

declare const extensionPointBrand: unique symbol

export type PluginExtensionPoint<T> = {
  readonly key: string
  /** Experimental points may change or vanish between releases. */
  readonly experimental: boolean
  // Phantom T keeps per-point register/resolve typed while runtime values contain only key/experimental.
  readonly [extensionPointBrand]?: T
}

export function definePluginExtensionPoint<T>(
  key: string,
  options: { experimental: boolean }
): PluginExtensionPoint<T> {
  return { key, experimental: options.experimental }
}

/** Lazily activate the worker when invoking its contributed command. */
export type PluginWorkerCommand = {
  readonly commandId: string
  invoke(args?: unknown): Promise<unknown>
}

export const PLUGIN_COMMAND_EXTENSION_POINT = definePluginExtensionPoint<PluginWorkerCommand>(
  'command',
  { experimental: true }
)

export type PluginExtensionRegistration<T> = {
  pluginId: string
  /** Contribution id within the plugin; addresses one of several providers. */
  providerId?: string
  implementation: T
}

export type PluginExtensionRegistry = {
  register<T>(
    point: PluginExtensionPoint<T>,
    pluginId: string,
    implementation: T,
    providerId?: string
  ): () => void
  resolveAll<T>(point: PluginExtensionPoint<T>): PluginExtensionRegistration<T>[]
  resolve<T>(point: PluginExtensionPoint<T>, pluginId: string, providerId?: string): T | null
  clearPlugin(pluginId: string): void
}

export function createPluginExtensionRegistry(): PluginExtensionRegistry {
  const byPoint = new Map<string, PluginExtensionRegistration<unknown>[]>()

  return {
    register(point, pluginId, implementation, providerId) {
      const registrations = byPoint.get(point.key) ?? []
      const entry = { pluginId, providerId, implementation }
      byPoint.set(point.key, [...registrations, entry])
      return () => {
        const current = byPoint.get(point.key) ?? []
        byPoint.set(
          point.key,
          current.filter((registration) => registration !== entry)
        )
      }
    },
    resolveAll<T>(point: PluginExtensionPoint<T>) {
      return (byPoint.get(point.key) ?? []) as PluginExtensionRegistration<T>[]
    },
    resolve<T>(point: PluginExtensionPoint<T>, pluginId: string, providerId?: string) {
      const registrations = (byPoint.get(point.key) ?? []) as PluginExtensionRegistration<T>[]
      // Without providerId, first registration wins; multi-provider plugins must be addressed by id.
      const match = registrations.find(
        (registration) =>
          registration.pluginId === pluginId &&
          (providerId === undefined || registration.providerId === providerId)
      )
      return match?.implementation ?? null
    },
    clearPlugin(pluginId) {
      for (const [key, registrations] of byPoint) {
        byPoint.set(
          key,
          registrations.filter((registration) => registration.pluginId !== pluginId)
        )
      }
    }
  }
}
