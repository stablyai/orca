import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import {
  BrowserTarget,
  ExpectUrlBrowserTarget,
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  requiredString
} from '../rpc-param-primitives'

export * from './browser-interaction-params'

export const CookieGet = lazyZodSchema(() =>
  BrowserTarget.extend({
    url: OptionalPlainString
  })
)

export const CookieSet = lazyZodSchema(() =>
  BrowserTarget.extend({
    name: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
      message: 'Missing name or value'
    }),
    value: z.custom<string>((v) => typeof v === 'string', {
      message: 'Missing name or value'
    }),
    domain: OptionalPlainString,
    path: OptionalPlainString,
    secure: OptionalBoolean,
    httpOnly: OptionalBoolean,
    sameSite: OptionalPlainString,
    expires: OptionalFiniteNumber
  })
)

export const CookieDelete = lazyZodSchema(() =>
  BrowserTarget.extend({
    name: requiredString('Missing cookie name'),
    domain: OptionalPlainString,
    url: OptionalPlainString
  })
)

export const Viewport = lazyZodSchema(() =>
  BrowserTarget.extend({
    width: z.custom<number>((v) => typeof v === 'number' && v > 0, {
      message: 'Width and height must be positive numbers'
    }),
    height: z.custom<number>((v) => typeof v === 'number' && v > 0, {
      message: 'Width and height must be positive numbers'
    }),
    deviceScaleFactor: OptionalFiniteNumber,
    mobile: OptionalBoolean
  })
)

export const Geolocation = lazyZodSchema(() =>
  BrowserTarget.extend({
    latitude: z.custom<number>((v) => typeof v === 'number', {
      message: 'Missing latitude or longitude'
    }),
    longitude: z.custom<number>((v) => typeof v === 'number', {
      message: 'Missing latitude or longitude'
    }),
    accuracy: OptionalFiniteNumber
  })
)

export const InterceptEnable = lazyZodSchema(() =>
  BrowserTarget.extend({
    patterns: z
      .unknown()
      .transform((v) => (Array.isArray(v) ? (v as string[]) : undefined))
      .pipe(z.union([z.array(z.string()), z.undefined()]))
      .optional()
  })
)

export const MouseXY = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    x: z.custom<number>((v) => typeof v === 'number', {
      message: 'Missing required x and y coordinates'
    }),
    y: z.custom<number>((v) => typeof v === 'number', {
      message: 'Missing required x and y coordinates'
    })
  })
)

const BROWSER_MOUSE_MODIFIERS = ['cmd', 'ctrl', 'alt', 'shift'] as const
export type BrowserMouseModifier = (typeof BROWSER_MOUSE_MODIFIERS)[number]

export const MouseModifiers = lazyZodSchema(() =>
  z
    .unknown()
    .transform((v) => (Array.isArray(v) ? v : undefined))
    .pipe(z.union([z.array(z.enum(BROWSER_MOUSE_MODIFIERS)), z.undefined()]))
    .optional()
)

// Older hosts strip `modifiers` from mouseDown/mouseUp, so a modified press arrives plain.
export const MouseButton = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    button: OptionalPlainString,
    modifiers: MouseModifiers
  })
)

export const MouseWheel = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    dy: z.custom<number>((v) => typeof v === 'number', {
      message: 'Missing required --dy'
    }),
    dx: OptionalFiniteNumber
  })
)

export const SetDevice = lazyZodSchema(() =>
  BrowserTarget.extend({
    name: requiredString('Missing required --name')
  })
)

export const SetOffline = lazyZodSchema(() =>
  BrowserTarget.extend({
    state: OptionalPlainString
  })
)

export const SetHeaders = lazyZodSchema(() =>
  BrowserTarget.extend({
    headers: requiredString('Missing required --headers (JSON string)')
  })
)

export const SetCredentials = lazyZodSchema(() =>
  BrowserTarget.extend({
    user: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
      message: 'Missing required --user and --pass'
    }),
    pass: z.custom<string>((v) => typeof v === 'string', {
      message: 'Missing required --user and --pass'
    })
  })
)

export const SetMedia = lazyZodSchema(() =>
  BrowserTarget.extend({
    colorScheme: OptionalPlainString,
    reducedMotion: OptionalPlainString
  })
)

export const ClipboardWrite = lazyZodSchema(() =>
  BrowserTarget.extend({
    text: requiredString('Missing required --text')
  })
)

export const DialogAccept = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    text: OptionalPlainString
  })
)

export const StorageKey = lazyZodSchema(() =>
  BrowserTarget.extend({
    key: requiredString('Missing required --key')
  })
)

export const StorageKeyValue = lazyZodSchema(() =>
  ExpectUrlBrowserTarget.extend({
    key: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
      message: 'Missing required --key and --value'
    }),
    value: z.custom<string>((v) => typeof v === 'string', {
      message: 'Missing required --key and --value'
    })
  })
)
