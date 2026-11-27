// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { nativeChatHeldElsewhereNow } from './native-chat-browser-file-refusal'
import {
  stageNativeChatDraftFile,
  stagedNativeChatFiles
} from '../drafts/native-chat-draft-attachment-staging'
import { structuredAgentSessionDraftScopeKey } from '../drafts/native-chat-draft-scope'

it.each([
  [10, 20],
  [20, 40]
] as const)(
  'looks up %s refused originals without visiting %s staging scopes',
  (references, scopes) => {
    const paths = Array.from(
      { length: references },
      (_, index) => `blob:indexed-${references}-${index}`
    )
    const restore: (() => void)[] = []
    let visits = 0
    for (let index = 0; index < scopes; index += 1) {
      const scope = structuredAgentSessionDraftScopeKey(`indexed-owner-${references}-${index}`)
      for (const path of index === 0 ? paths : [`blob:filler-${references}-${index}`]) {
        stageNativeChatDraftFile(scope, path)
      }
      const paths = stagedNativeChatFiles(scope)!.draftPaths
      const has = paths.has.bind(paths)
      const spy = vi.spyOn(paths, 'has').mockImplementation((path) => {
        visits += 1
        return has(path)
      })
      restore.push(() => spy.mockRestore())
    }
    expect(nativeChatHeldElsewhereNow(paths, 'indexed-refusing').held).toEqual({
      count: references,
      ownerSessionId: `indexed-owner-${references}-0`
    })
    expect(spies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(0)
    spies.forEach((spy) => spy.mockRestore())
  }
)
