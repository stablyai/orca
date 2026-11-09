/** Google publishes no Windows Antigravity chat server Orca can install (#30817); there it runs only on agy. */
export function structuredChatUnavailableOnPlatform(
  agent: string,
  platform: string | null | undefined
): boolean {
  return agent === 'antigravity' && platform === 'win32'
}
