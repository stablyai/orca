/** Single source of truth: main broadcasts on this channel, preload subscribes to it. */
export const UPDATER_INSTALL_COMMITTED_CHANNEL = 'updater:installCommitted'
/**
 * Read synchronously in preload, before any document script runs.
 *
 * Why sync: a renderer document created or reloaded mid-install (View → Reload,
 * crash recovery, dock activation, …) misses the broadcast, and an async seed can
 * lose the race — on Linux main is blocked inside the package manager's spawnSync
 * and cannot answer at all. A document that starts during an install must know it
 * before its first lazy import, or it reads a swapped archive.
 */
export const UPDATER_IS_INSTALL_COMMITTED_SYNC_CHANNEL = 'updater:isInstallCommittedSync'
