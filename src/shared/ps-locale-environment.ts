/** macOS ps localizes lstart (%c) and vis-encodes non-ASCII argv; en_US.UTF-8 yields the parsed shape. */
export function psLocaleEnvironment(): NodeJS.ProcessEnv | undefined {
  return process.platform === 'darwin' ? { ...process.env, LC_ALL: 'en_US.UTF-8' } : undefined
}
