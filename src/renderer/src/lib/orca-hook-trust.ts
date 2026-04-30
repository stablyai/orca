export type OrcaHookScriptKind = 'setup' | 'archive' | 'issueCommand'

export async function hashOrcaHookScript(content: string): Promise<string> {
  const normalized = content.trim()
  const bytes = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex: string[] = []
  const view = new Uint8Array(digest)
  for (let i = 0; i < view.length; i += 1) {
    hex.push(view[i].toString(16).padStart(2, '0'))
  }
  return hex.join('')
}
