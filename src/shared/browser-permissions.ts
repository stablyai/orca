import type {
  BrowserInteractionMode,
  BrowserPermissionAction,
  BrowserPermissionDefaults,
  BrowserPermissionNoticePolicy,
  BrowserSitePermissionRule,
  GlobalSettings
} from './types'

export const BROWSER_PERMISSION_ORDER = [
  'fullscreen',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'pointerLock',
  'geolocation',
  'media'
] as const

export const BROWSER_PERMISSION_LABELS: Record<string, string> = {
  fullscreen: 'Fullscreen',
  notifications: 'Notifications',
  'clipboard-read': 'Clipboard Read',
  'clipboard-sanitized-write': 'Clipboard Write',
  pointerLock: 'Pointer Lock',
  geolocation: 'Geolocation',
  media: 'Camera / Microphone'
}

const ALWAYS_DENY_PERMISSIONS = new Set(['midi', 'serial', 'hid', 'usb', 'bluetooth'])
const SUPPORTED_PERMISSIONS = new Set<string>(BROWSER_PERMISSION_ORDER)
const TRUSTED_ORIGIN_REQUIRED_PERMISSIONS = new Set([
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'pointerLock',
  'geolocation',
  'media'
])
const IMPORTANT_PERMISSIONS = new Set([
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'media',
  'geolocation'
])
const BROWSER_PERMISSION_ACTIONS = new Set<BrowserPermissionAction>(['allow', 'deny', 'prompt'])
const DEFAULT_BROWSER_PROFILE_ID = 'default'

export type BrowserPermissionSettingsSnapshot = Pick<
  GlobalSettings,
  | 'browserInteractionMode'
  | 'browserPermissionDefaults'
  | 'browserSitePermissionRules'
  | 'browserPermissionNoticePolicy'
>

export function normalizePermissionOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null
    }
    return parsed.origin === 'null' ? null : parsed.origin
  } catch {
    return null
  }
}

export function isSupportedBrowserPermission(permission: string): boolean {
  return SUPPORTED_PERMISSIONS.has(permission)
}

export function getModePermissionDefaults(mode: BrowserInteractionMode): BrowserPermissionDefaults {
  if (mode === 'human') {
    return {
      fullscreen: 'allow',
      notifications: 'prompt',
      'clipboard-read': 'prompt',
      'clipboard-sanitized-write': 'prompt',
      pointerLock: 'prompt',
      geolocation: 'prompt',
      media: 'prompt'
    }
  }

  return {
    fullscreen: 'allow',
    'clipboard-read': 'allow',
    'clipboard-sanitized-write': 'allow',
    notifications: 'deny',
    pointerLock: 'deny',
    geolocation: 'deny',
    media: 'allow'
  }
}

export function resolveBrowserPermissionDecision(args: {
  origin: string
  permission: string
  profileId?: string | null
  settings: BrowserPermissionSettingsSnapshot
}): BrowserPermissionAction {
  if (!isSupportedBrowserPermission(args.permission)) {
    return 'deny'
  }

  const normalizedOrigin = normalizePermissionOrigin(args.origin)
  const profileId = normalizeProfileId(args.profileId)
  if (normalizedOrigin) {
    for (let index = args.settings.browserSitePermissionRules.length - 1; index >= 0; index -= 1) {
      const rule = args.settings.browserSitePermissionRules[index]
      if (
        normalizePermissionOrigin(rule.origin) === normalizedOrigin &&
        normalizeProfileId(rule.profileId) === profileId &&
        rule.permission === args.permission
      ) {
        return applyPermissionSafetyFloor(args.permission, rule.action)
      }
    }
  }

  // Why: opaque origins such as data: or file: cannot be reviewed as a site,
  // so origin-sensitive browser capabilities fail closed instead of prompting.
  if (!normalizedOrigin && TRUSTED_ORIGIN_REQUIRED_PERMISSIONS.has(args.permission)) {
    return 'deny'
  }

  const override = args.settings.browserPermissionDefaults[args.permission]
  if (isBrowserPermissionAction(override)) {
    return applyPermissionSafetyFloor(args.permission, override)
  }

  return applyPermissionSafetyFloor(
    args.permission,
    getModePermissionDefaults(args.settings.browserInteractionMode)[args.permission] ??
      (args.settings.browserInteractionMode === 'human' ? 'prompt' : 'deny')
  )
}

export function applyPermissionSafetyFloor(
  permission: string,
  action: BrowserPermissionAction
): BrowserPermissionAction {
  if (ALWAYS_DENY_PERMISSIONS.has(permission) || !isSupportedBrowserPermission(permission)) {
    return 'deny'
  }
  return action
}

export function shouldNotifyPermissionDenied(
  permission: string,
  noticePolicy: BrowserPermissionNoticePolicy
): boolean {
  if (noticePolicy === 'silent-auto-deny') {
    return false
  }
  if (noticePolicy === 'all') {
    return true
  }
  return IMPORTANT_PERMISSIONS.has(permission)
}

export function upsertSitePermissionRule(
  rules: BrowserSitePermissionRule[],
  nextRule: BrowserSitePermissionRule
): BrowserSitePermissionRule[] {
  const normalizedOrigin = normalizePermissionOrigin(nextRule.origin)
  if (
    !normalizedOrigin ||
    !isSupportedBrowserPermission(nextRule.permission) ||
    !isRememberedPermissionAction(nextRule.action)
  ) {
    return rules
  }
  const profileId = normalizeProfileId(nextRule.profileId)
  const remaining = rules.filter(
    (rule) =>
      !(
        normalizePermissionOrigin(rule.origin) === normalizedOrigin &&
        normalizeProfileId(rule.profileId) === profileId &&
        rule.permission === nextRule.permission
      )
  )
  return [...remaining, { ...nextRule, profileId, origin: normalizedOrigin }]
}

function normalizeProfileId(profileId: string | null | undefined): string {
  const trimmed = profileId?.trim()
  return trimmed || DEFAULT_BROWSER_PROFILE_ID
}

function isBrowserPermissionAction(action: unknown): action is BrowserPermissionAction {
  return (
    typeof action === 'string' && BROWSER_PERMISSION_ACTIONS.has(action as BrowserPermissionAction)
  )
}

function isRememberedPermissionAction(
  action: unknown
): action is Exclude<BrowserPermissionAction, 'prompt'> {
  return action === 'allow' || action === 'deny'
}
