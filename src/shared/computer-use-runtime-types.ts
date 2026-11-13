export const COMPUTER_ERROR_CODES = {
  app_not_found: 'app_not_found',
  app_blocked: 'app_blocked',
  system_shortcut_blocked: 'system_shortcut_blocked',
  window_not_found: 'window_not_found',
  window_not_focused: 'window_not_focused',
  background_unavailable: 'background_unavailable',
  window_stale: 'window_stale',
  provider_incompatible: 'provider_incompatible',
  unsupported_capability: 'unsupported_capability',
  permission_denied: 'permission_denied',
  element_not_found: 'element_not_found',
  element_not_clickable: 'element_not_clickable',
  element_not_enabled: 'element_not_enabled',
  action_not_supported: 'action_not_supported',
  value_not_settable: 'value_not_settable',
  invalid_argument: 'invalid_argument',
  action_timeout: 'action_timeout',
  verification_failed: 'verification_failed',
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
  // Present only when treeText is the subtree of this element, read with rootElementIndex.
  rootElementIndex?: number
  // Present only when treeText is a diff against the previous snapshot of the same window.
  treeDiff?: {
    baseSnapshotId: string
    changed: number
    added: number
    removed: number
  }
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
  // Absent from providers that predate background input (Linux, older Windows and macOS helpers).
  delivery?: 'background' | 'foreground'
  verification?: ComputerActionVerification
}

export type ComputerActionVerification =
  | {
      state: 'verified'
      property: 'focusedText' | 'elementText' | 'selection' | 'value'
    }
  | {
      state: 'unverified'
      reason:
        | 'synthetic_input'
        | 'clipboard_paste'
        | 'accessibility_action_unasserted'
        | 'provider_unavailable'
        | 'readback_unsupported'
        | 'window_changed'
        | 'value_mismatch'
        // The accessibility call succeeded but the window and the app's windows looked the same about a second later.
        | 'suspected_noop'
        // Typed or pasted text was read back and the focused field does not hold what inserting it should produce.
        | 'text_mismatch'
      // Only on value_mismatch from a non-secure field; results never repeat the requested value.
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
      // Absent from runtimes that predate action-result tree diffs.
      treeDiff?: boolean
      // Tree lines mark disabled elements with a `(disabled)` trait. Absent from older Linux and Windows providers.
      disabledState?: boolean
    }
    actions: {
      click: boolean
      typeText: boolean
      // Absent from providers that predate element-targeted typing; they type at focus and ignore the element.
      typeTextElement?: boolean
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
    // Absent from providers that predate background input.
    input?: {
      background: boolean
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
