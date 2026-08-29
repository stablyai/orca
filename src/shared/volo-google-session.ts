// Volo's CLI Google callback is hardcoded to this port on the server.
export const VOLO_GOOGLE_CLI_CALLBACK_PORT = 8080
export const VOLO_GOOGLE_SESSION_SKEW_MS = 60_000

export type VoloGoogleSession = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  userId: string
  email: string
  name: string
}

export type VoloRefreshTokens = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export function voloGoogleCliAuthorizeUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/api/auth/cli/google`
}

export function parseVoloGoogleCallbackSearch(search: string, now = Date.now()): VoloGoogleSession {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const error = params.get('error')
  if (error) {
    throw new Error(params.get('message') || 'Google authentication failed.')
  }
  const accessToken = params.get('accessToken')?.trim() ?? ''
  if (!accessToken) {
    throw new Error('No access token received from Volo.')
  }
  const expiresIn = Number.parseInt(params.get('expiresIn') || '0', 10)
  return {
    accessToken,
    refreshToken: params.get('refreshToken')?.trim() ?? '',
    expiresAt: now + (Number.isFinite(expiresIn) ? Math.max(expiresIn, 0) : 0) * 1000,
    userId: params.get('userId')?.trim() ?? '',
    email: params.get('email')?.trim() ?? '',
    name: params.get('name')?.trim() ?? ''
  }
}

export function parseVoloGoogleSession(value: unknown): VoloGoogleSession | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.accessToken !== 'string' || record.accessToken.trim().length === 0) {
    return null
  }
  return {
    accessToken: record.accessToken.trim(),
    refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken.trim() : '',
    expiresAt:
      typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt
        : 0,
    userId: typeof record.userId === 'string' ? record.userId : '',
    email: typeof record.email === 'string' ? record.email : '',
    name: typeof record.name === 'string' ? record.name : ''
  }
}

export function parseStoredVoloSecret(raw: string): VoloGoogleSession | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.startsWith('{')) {
    try {
      return parseVoloGoogleSession(JSON.parse(trimmed) as unknown)
    } catch {
      return null
    }
  }
  return {
    accessToken: trimmed,
    refreshToken: '',
    expiresAt: 0,
    userId: '',
    email: '',
    name: ''
  }
}

export function sessionAccessExpired(session: VoloGoogleSession, now = Date.now()): boolean {
  return session.expiresAt > 0 && now >= session.expiresAt - VOLO_GOOGLE_SESSION_SKEW_MS
}

export function applyVoloRefreshTokens(
  session: VoloGoogleSession,
  tokens: VoloRefreshTokens,
  now = Date.now()
): VoloGoogleSession {
  return {
    ...session,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + Math.max(tokens.expiresIn, 0) * 1000
  }
}
