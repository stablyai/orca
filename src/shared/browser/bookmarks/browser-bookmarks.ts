import { z } from 'zod'
import { redactKagiSessionToken } from '../navigation/browser-url'

export function normalizeBrowserBookmarkUrl(input: string): string | null {
  const url = URL.parse(input.trim())
  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    return null
  }
  return redactKagiSessionToken(url.href)
}

export const browserBookmarkScopeSchema = z.tuple([
  z
    .string()
    .max(512)
    .regex(/^(runtime|ssh):.+$/)
    .nullable(),
  z.string().min(1).max(512)
])
export type BrowserBookmarkScope = z.infer<typeof browserBookmarkScopeSchema>
export const browserBookmarkScopeKey = (scope: BrowserBookmarkScope): string =>
  JSON.stringify(scope)

export function parseBrowserBookmarkScopeKey(key: string): BrowserBookmarkScope | null {
  if (!key.startsWith('[')) {
    return null
  }
  try {
    const scope = browserBookmarkScopeSchema.safeParse(JSON.parse(key))
    return scope.success && browserBookmarkScopeKey(scope.data) === key ? scope.data : null
  } catch {
    return null
  }
}

export const browserBookmarkFieldsSchema = z.object({
  url: z.string().transform((input, context) => {
    const url = normalizeBrowserBookmarkUrl(input)
    if (url === null) {
      context.addIssue({ code: 'custom', message: 'Invalid bookmark URL' })
      return z.NEVER
    }
    return url
  }),
  title: z.string().trim()
})
export const browserBookmarkSchema = browserBookmarkFieldsSchema.extend({ id: z.uuid() })
export type BrowserBookmark = z.infer<typeof browserBookmarkSchema>
export type BrowserBookmarks = Record<string, BrowserBookmark[]>

export const browserBookmarkMutationSchema = z.discriminatedUnion('kind', [
  browserBookmarkFieldsSchema.extend({ kind: z.literal('add') }),
  browserBookmarkSchema.extend({ kind: z.literal('edit') }),
  z.object({ kind: z.literal('remove'), id: z.uuid() })
])
export type BrowserBookmarkMutation = z.infer<typeof browserBookmarkMutationSchema>
export type BrowserBookmarkMutationResult = 'saved' | 'duplicate' | 'missing'

export type BrowserBookmarksApi = {
  list: () => Promise<BrowserBookmarks>
  mutate: (
    scope: BrowserBookmarkScope,
    mutation: BrowserBookmarkMutation
  ) => Promise<BrowserBookmarkMutationResult>
  onChanged: (callback: (bookmarks: BrowserBookmarks) => void) => () => void
}
