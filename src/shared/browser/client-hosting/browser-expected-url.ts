import { z } from 'zod'

export const BROWSER_EXPECTED_URL_MISMATCH_CODE = 'browser_expected_url_mismatch'
export const BROWSER_EXPECT_URL_UNSUPPORTED_CODE = 'browser_expect_url_unsupported'

const MAX_URL_CHARS = 8192

/** Carried in the error's data so a caller never has to parse its message. */
export const BrowserExpectedUrlMismatch = z.object({
  expectedUrl: z.string().max(MAX_URL_CHARS),
  actualUrl: z.string().max(MAX_URL_CHARS),
  browserPageId: z.string().min(1).max(256),
  /** True once a step of the command may have reached the page. */
  mayHaveStarted: z.boolean()
})
export type BrowserExpectedUrlMismatch = z.infer<typeof BrowserExpectedUrlMismatch>

export function expectedUrlMismatchMessage(mismatch: BrowserExpectedUrlMismatch): string {
  const outcome = mismatch.mayHaveStarted
    ? 'The command stopped before its next step; earlier steps may have taken effect.'
    : 'The command did not run.'
  return `Browser page ${mismatch.browserPageId} is at ${mismatch.actualUrl}, not the expected ${mismatch.expectedUrl}. ${outcome}`
}

/** A page's own URL can outgrow what the wire carries, and the diagnostic only has to name it. */
export function clipUrlForMismatch(url: string): string {
  return url.slice(0, MAX_URL_CHARS)
}

// `localhost:3000/a` parses with `localhost:` as its scheme and could then never match a page.
const HOST_AND_PORT_WITHOUT_SCHEME = /^[^/:]+:\d/

export function isAbsoluteBrowserUrl(raw: string): boolean {
  return raw.length <= MAX_URL_CHARS && !HOST_AND_PORT_WITHOUT_SCHEME.test(raw) && URL.canParse(raw)
}

/** Path, query and fragment can each name the resource, so only URL spelling is normalized. */
export function isSameBrowserUrl(left: string, right: string): boolean {
  return comparableUrl(left) === comparableUrl(right)
}

function comparableUrl(raw: string): string {
  // A guest before its first commit reports an empty URL, which matches nothing an agent can expect.
  return URL.canParse(raw) ? new URL(raw).href : raw
}
