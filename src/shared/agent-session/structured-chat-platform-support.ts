/** Previously Google published no Windows Antigravity chat server (#30817); host agy CLI now ships with ACP support on Windows. */
export function structuredChatUnavailableOnPlatform(
  _agent: string,
  _platform: string | null | undefined
): boolean {
  return false
}
