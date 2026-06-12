type AtlasResettablePaneManager = {
  resetWebglTextureAtlases(): void
}

const liveManagers = new Set<AtlasResettablePaneManager>()

export function registerLivePaneManager(manager: AtlasResettablePaneManager): void {
  liveManagers.add(manager)
}

export function unregisterLivePaneManager(manager: AtlasResettablePaneManager): void {
  liveManagers.delete(manager)
}

/**
 * Resets the WebGL glyph atlases of every live pane manager, not just one.
 *
 * Why: @xterm/addon-webgl keeps a module-global atlas cache, so terminals with
 * identical font configs share one glyph texture atlas. Clearing it through a
 * single manager invalidates the cached glyph coordinates of every other
 * sharing terminal without rebuilding their render models, which paints them
 * as garbled glyphs. Recovery resets must therefore rebuild all terminals.
 */
export function resetAllTerminalWebglAtlases(): void {
  for (const manager of liveManagers) {
    manager.resetWebglTextureAtlases()
  }
}
