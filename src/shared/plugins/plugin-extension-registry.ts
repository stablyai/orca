/**
 * Typed extension-point registry. An extension point is a named, typed slot
 * (like a Go interface value); plugins register implementations and hosts
 * resolve them without compile-time knowledge of the implementor. Runtime
 * registration because plugins load (and unload) dynamically.
 *
 * All P0 points are EXPERIMENTAL — excluded from compatibility guarantees.
 */

declare const extensionPointBrand: unique symbol

export type PluginExtensionPoint<T> = {
  readonly key: string
  /** Experimental points may change or vanish between releases. */
  readonly experimental: boolean
  // Why: phantom field carries T so register/resolve stay type-safe per point
  // even though the runtime value is just `{ key, experimental }`.
  readonly [extensionPointBrand]?: T
}

export function definePluginExtensionPoint<T>(
  key: string,
  options: { experimental: boolean }
): PluginExtensionPoint<T> {
  return { key, experimental: options.experimental }
}

/** A contributed command whose handler lives in the plugin's worker. The
 *  proxy lazily activates the worker on first invoke. */
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
      // Why: without a providerId the first registration wins — only safe for
      // single-provider plugins; multi-provider callers must address by id.
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
