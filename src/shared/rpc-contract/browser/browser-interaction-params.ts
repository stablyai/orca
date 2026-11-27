import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import {
  BrowserTarget,
  ExpectUrlBrowserTarget,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString,
  requiredStringAllowingEmpty
} from '../rpc-param-primitives'

export const Element = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    element: requiredString('Missing required --element')
  })
)

export const Goto = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    url: requiredString('Missing required --url')
  })
)

export const Fill = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    element: requiredString('Missing required --element'),
    value: requiredStringAllowingEmpty('Missing required --value')
  })
)

export const Type = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    input: requiredString('Missing required --input')
  })
)

export const Select = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    element: requiredString('Missing required --element'),
    value: z.custom<string>((v) => typeof v === 'string', {
      message: 'Missing required --value'
    })
  })
)

export const Scroll = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    direction: z.custom<'up' | 'down'>((v) => v === 'up' || v === 'down', {
      message: 'Missing required --direction (up or down)'
    }),
    amount: z
      .unknown()
      .transform((v) => (typeof v === 'number' && v > 0 ? v : undefined))
      .pipe(z.union([z.number(), z.undefined()]))
      .optional()
  })
)

export const FullScreenshot = lazyZodSchema(() =>
  BrowserTarget.extend({
    format: z
      .unknown()
      .optional()
      .transform((v) => (v === 'jpeg' ? 'jpeg' : 'png'))
      .pipe(z.enum(['png', 'jpeg']))
  })
)

export const Eval = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    expression: requiredString('Missing required --expression')
  })
)

export const TabList = lazyZodSchema(() => z.object({ worktree: OptionalString }))

// Require exactly one of index/page. Opt-in focus reveals only within the current worktree;
// other worktrees silently stage selection so parallel agents cannot steal the screen.
export const TabSwitch = lazyZodSchema(() =>
  BrowserTarget.extend({
    index: z
      .unknown()
      .transform((v) => (typeof v === 'number' ? v : undefined))
      .pipe(z.union([z.number(), z.undefined()]))
      .optional(),
    focus: z.boolean().optional()
  }).refine(
    (val) => {
      if (val.page !== undefined) {
        return true
      }
      return val.index !== undefined && Number.isInteger(val.index) && val.index >= 0
    },
    { message: 'Missing required --index (non-negative integer) or --page' }
  )
)

export const TabShow = lazyZodSchema(() =>
  z.object({
    page: requiredString('Missing required --page'),
    worktree: OptionalString
  })
)

export const TabCurrent = lazyZodSchema(() => z.object({ worktree: OptionalString }))

export const TabClose = lazyZodSchema(() =>
  z.object({
    index: z
      .unknown()
      .transform((v) => (typeof v === 'number' ? v : undefined))
      .pipe(z.union([z.number(), z.undefined()]))
      .optional(),
    page: OptionalString,
    worktree: OptionalString
  })
)

export const TabSetProfile = lazyZodSchema(() =>
  BrowserTarget.extend({
    profileId: requiredString('Missing required --profile')
  })
)

export const TabProfileClone = lazyZodSchema(() =>
  BrowserTarget.extend({
    profileId: requiredString('Missing required --profile')
  })
)

export const ProfileDelete = lazyZodSchema(() =>
  z.object({ profileId: requiredString('Missing required --profile') })
)

export const ProfileClearGoogleCookies = lazyZodSchema(() =>
  ProfileDelete.extend({
    executorRuntimeId: z.string().min(1)
  })
)

export const ProfileClearCookies = ProfileClearGoogleCookies

export const ProfileImportFromBrowser = lazyZodSchema(() =>
  z.object({
    profileId: requiredString('Missing required --profile'),
    browserFamily: requiredString('Missing required --browser-family'),
    browserProfile: OptionalString,
    supportsPartitionSkippedCookies: z.literal(true).optional()
  })
)

export const Drag = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    from: requiredString('Missing required --from and --to element refs'),
    to: requiredString('Missing required --from and --to element refs')
  })
)

export const Upload = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    element: requiredString('Missing required --element and --files'),
    files: z.custom<string[]>(
      (v) => Array.isArray(v) && v.length > 0 && v.every((f) => typeof f === 'string'),
      { message: 'Missing required --element and --files' }
    )
  })
)

export const Wait = lazyZodSchema(() =>
  BrowserTarget.extend({
    selector: OptionalPlainString,
    timeout: z
      .unknown()
      .transform((v) => (typeof v === 'number' && v > 0 ? v : undefined))
      .pipe(z.union([z.number(), z.undefined()]))
      .optional(),
    text: OptionalPlainString,
    url: OptionalPlainString,
    load: OptionalPlainString,
    fn: OptionalPlainString,
    state: OptionalPlainString
  })
)

export const Check = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    element: requiredString('Missing required --element'),
    checked: z
      .unknown()
      .optional()
      .transform((v) => (v === undefined ? true : v))
      .pipe(z.boolean())
  })
)

export const Keypress = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    key: requiredString('Missing required --key')
  })
)

export const SelectorPath = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    selector: requiredString('Missing required --selector and --path'),
    path: requiredString('Missing required --selector and --path')
  })
)

export const Highlight = lazyZodSchema(() =>
  BrowserTarget.extend({
    selector: requiredString('Missing required --selector')
  })
)

export const Exec = lazyZodSchema(() =>
  BrowserTarget.extend({
    command: requiredString('Missing required --command'),
    // A local caller's directory (and legacy WSL distro), so file operands resolve as it typed them.
    cwd: OptionalString,
    wslDistro: OptionalString
  })
)

export const Get = lazyZodSchema(() =>
  BrowserTarget.extend({
    what: requiredString('Missing required --what'),
    selector: OptionalString
  })
)

export const Is = lazyZodSchema(() =>
  BrowserTarget.extend({
    what: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
      message: 'Missing required --what and --element'
    }),
    selector: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
      message: 'Missing required --what and --element'
    })
  })
)

export const KeyboardInsert = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    text: requiredString('Missing required --text')
  })
)

export const LimitParam = lazyZodSchema(() =>
  BrowserTarget.extend({
    limit: OptionalFiniteNumber
  })
)

export const Find = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    locator: requiredString('Missing required --locator, --value, and --action'),
    value: requiredString('Missing required --locator, --value, and --action'),
    action: requiredString('Missing required --locator, --value, and --action'),
    text: OptionalString
  })
)
