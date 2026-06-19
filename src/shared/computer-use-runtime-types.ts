// Computer-use types (see docs/computer-use/plan.md §4 and §12.6).

export const COMPUTER_ERROR_CODES = {
  app_not_found: 'app_not_found',
  app_blocked: 'app_blocked',
  window_not_found: 'window_not_found',
  window_not_focused: 'window_not_focused',
  window_stale: 'window_stale',
  provider_incompatible: 'provider_incompatible',
  unsupported_capability: 'unsupported_capability',
  permission_denied: 'permission_denied',
  element_not_found: 'element_not_found',
  element_not_clickable: 'element_not_clickable',
  action_not_supported: 'action_not_supported',
  value_not_settable: 'value_not_settable',
  invalid_argument: 'invalid_argument',
  action_timeout: 'action_timeout',
  screenshot_failed: 'screenshot_failed',
  accessibility_error: 'accessibility_error'
} as const

export type ComputerErrorCode = keyof typeof COMPUTER_ERROR_CODES

export type ComputerAppQuery = string

export type ComputerAppInfo = {
  name: string
  bundleId: string | null
  pid: number
}

export type ComputerWindowInfo = {
  id?: number | null
  index?: number | null
  title: string
  x?: number | null
  y?: number | null
  width: number
  height: number
  isMinimized?: boolean | null
  isOffscreen?: boolean | null
  screenIndex?: number | null
  platform?: Record<string, unknown>
}

export type ComputerSnapshotData = {
  id: string
  app: ComputerAppInfo
  window: ComputerWindowInfo
  coordinateSpace: 'window'
  treeText: string
  elementCount: number
  focusedElementId: number | null
  truncation?: {
    truncated: boolean
    maxNodes?: number
    maxDepth?: number
    maxDepthReached?: boolean
  }
}

export type ComputerScreenshotData = {
  data?: string
  format: 'png'
  width: number
  height: number
  scale: number
  path?: string
  dataOmitted?: boolean
  expiresAt?: string
}

export type ComputerScreenshotMetadata = {
  engine?: 'screenCaptureKit' | 'cgWindowList' | 'unknown'
  windowId?: number | null
}

export type ComputerScreenshotStatus =
  | { state: 'captured'; metadata?: ComputerScreenshotMetadata }
  | { state: 'skipped'; reason: 'no_screenshot_flag' }
  | {
      state: 'failed'
      code: ComputerErrorCode
      message: string
      metadata?: ComputerScreenshotMetadata
    }

export type ComputerActionMetadata = {
  path: 'accessibility' | 'synthetic' | 'clipboard'
  actionName?: string | null
  fallbackReason?: string | null
  targetWindowId?: number | null
  targetWindowIndex?: number | null
  verification?: ComputerActionVerification
}

export type ComputerActionVerification =
  | {
      state: 'verified'
      property: 'focusedText' | 'selection' | 'value'
      expected?: string | null
      actualPreview?: string | null
    }
  | {
      state: 'unverified'
      reason:
        | 'synthetic_input'
        | 'clipboard_paste'
        | 'provider_unavailable'
        | 'window_changed'
        | 'value_mismatch'
      expected?: string | null
      actualPreview?: string | null
    }

export type ComputerSnapshotResult = {
  snapshot: ComputerSnapshotData
  screenshot: ComputerScreenshotData | null
  screenshotStatus: ComputerScreenshotStatus
}

export type ComputerActionResult = ComputerSnapshotResult & {
  action?: ComputerActionMetadata
}

export type ComputerProviderCapabilities = {
  platform: NodeJS.Platform
  provider: string
  providerVersion: string
  protocolVersion: number
  supports: {
    apps: {
      list: boolean
      bundleIds: boolean
      pids: boolean
    }
    windows: {
      list: boolean
      targetById: boolean
      targetByIndex: boolean
      focus: boolean
      moveResize: boolean
    }
    observation: {
      screenshot: boolean
      annotatedScreenshot: boolean
      elementFrames: boolean
      ocr: boolean
    }
    actions: {
      click: boolean
      typeText: boolean
      pressKey: boolean
      hotkey: boolean
      pasteText: boolean
      scroll: boolean
      drag: boolean
      setValue: boolean
      performAction: boolean
    }
    surfaces: {
      menus: boolean
      dialogs: boolean
      dock: boolean
      menubar: boolean
    }
  }
}

export type ComputerWindowListWindow = ComputerWindowInfo & {
  app: ComputerAppInfo
  index: number
  isMain?: boolean | null
}

export type ComputerListWindowsResult = {
  app: ComputerAppInfo
  windows: ComputerWindowListWindow[]
}

export type ComputerListAppsResult = {
  apps: (ComputerAppInfo & {
    isRunning: boolean
    lastUsedAt: string | null
    useCount: number | null
  })[]
}
