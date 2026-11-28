import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { RUNTIME_NAVIGATION_TARGETS } from '../../remote-runtime/session-graph/runtime-navigation'
import { BrowserPageCreationPlacement } from '../../browser/client-hosting/browser-client-host-placement'
import { OptionalString } from '../rpc-param-primitives'
import { BROWSER_TAB_SPLIT_DIRECTIONS } from '../../browser/workspaces/browser-tab-split-direction'

export const BrowserTabCreateParams = lazyZodSchema(() =>
  z.object({
    url: OptionalString,
    worktree: OptionalString,
    page: OptionalString,
    profileId: OptionalString,
    waitForRegistration: z.boolean().optional(),
    activate: z.boolean().optional(),
    // Why: `activate` says the caller wants the new tab selected; `navigation` says on whose screens.
    // Absent, a paired caller means 'caller' — one device's create must not steer every other UI.
    navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional(),
    targetGroupId: OptionalString,
    placement: BrowserPageCreationPlacement.optional(),
    // Why optional: older hosts drop unknown fields and fall back to a plain tab, which is safe.
    split: z.enum(BROWSER_TAB_SPLIT_DIRECTIONS).optional(),
    // The terminal tab the split is placed beside; absent or stale falls back to the active pane.
    splitFromTabId: OptionalString
  })
)

export const BrowserOpenUrlParams = lazyZodSchema(() =>
  z.object({
    url: z.url(),
    worktree: z.string().min(1),
    // The terminal tab that opened it: only screens showing it move to a page the server opens. Older hosts drop it.
    fromTabId: OptionalString
  })
)
