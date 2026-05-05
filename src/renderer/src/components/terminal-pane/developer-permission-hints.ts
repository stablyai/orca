import type { DeveloperPermissionId } from '../../../../shared/developer-permissions-types'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI_PATTERN = new RegExp(
  `${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\))`,
  'g'
)

type DeveloperPermissionHint = {
  permissionId: DeveloperPermissionId
  title: string
  description: string
}

export function detectDeveloperPermissionHint(data: string): DeveloperPermissionHint | null {
  const normalized = data.slice(-4000).replace(ANSI_PATTERN, '').toLowerCase()

  if (
    /\b(microphone|audio input|input device|default input device)\b/.test(normalized) &&
    /\b(permission|denied|not authorized|unauthorized|no audio|not permitted)\b/.test(normalized)
  ) {
    return {
      permissionId: 'microphone',
      title: 'This command may need microphone access',
      description: 'Open Developer Permissions to enable audio capture for terminal tools.'
    }
  }

  if (
    /\b(camera|webcam|video capture)\b/.test(normalized) &&
    /\b(permission|denied|not authorized|unauthorized|not permitted)\b/.test(normalized)
  ) {
    return {
      permissionId: 'camera',
      title: 'This command may need camera access',
      description: 'Open Developer Permissions to enable camera capture for terminal tools.'
    }
  }

  if (
    /\b(screen recording|screen capture|screencapture|desktop capture)\b/.test(normalized) &&
    /\b(permission|denied|not authorized|unauthorized|not permitted)\b/.test(normalized)
  ) {
    return {
      permissionId: 'screen',
      title: 'This command may need screen recording access',
      description: 'Open Developer Permissions to enable screenshots and screen capture.'
    }
  }

  if (
    /\b(apple events|osascript|system events|automation)\b/.test(normalized) &&
    /\b(not authorized|not allowed|permission|denied|not permitted)\b/.test(normalized)
  ) {
    return {
      permissionId: 'automation',
      title: 'This command may need automation access',
      description: 'Open Developer Permissions to allow Apple Events for terminal scripts.'
    }
  }

  return null
}
