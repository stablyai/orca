import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const components = join(__dirname, '..')
// The screens this ratchet holds to the shared surface; a source check, not proof of behaviour.
const screens = [
  'native-chat/NativeChatStructuredSession.tsx',
  'native-chat/NativeChatResolvedView.tsx',
  'bots/BotGroupChat.tsx'
]
const transcripts = ['native-chat/NativeChatMessageList.tsx', 'bots/BotGroupChat.tsx']

// Wiring that only the surface or the viewport may do; a screen holding its own copy drifts.
const surfaceOwned = [
  'use-native-chat-find',
  'NativeChatFindBar',
  'use-native-chat-link-actions',
  'LinkActionPopover',
  'use-native-chat-root-input-routing',
  'use-native-chat-context-menu',
  'use-native-chat-paste-bridge',
  'use-native-chat-font-size',
  'use-native-chat-store-appearance-style',
  'NATIVE_CHAT_APPEARANCE_ROOT_CLASS',
  'native-chat-split-shortcut',
  // `/resume` opens history only through the composer, scoped by the surface.
  'openAgentSessionHistoryModal',
  'NativeChatSessionHistoryScopeContext'
]
const viewportOwned = [
  'NativeChatJumpToLatest',
  'NativeChatForwardedGestureContext',
  'NativeChatDisclosureContext',
  'copyChatMathSelection',
  'data-native-chat-scroll'
]

function source(file: string): string {
  return readFileSync(join(components, file), 'utf8')
}

// Drawn before a session exists: no transcript, menu, links or Find to share.
const placeholderRoots = ['worktree-creation/PendingNativeChatCreation.tsx']

describe('chat screens share one surface', () => {
  it('only the surface draws a chat root, so a new chat screen cannot skip it', () => {
    const drawsRoot = readdirSync(components, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.tsx') && !/\.(test|spec)\.|fixture|harness/.test(file))
      .filter((file) => /\sdata-native-chat-root[\s=>]/.test(source(file)))
      .map((file) => relative(components, join(components, file)).replaceAll('\\', '/'))
      .sort()
    expect(drawsRoot).toEqual(['native-chat/NativeChatSurface.tsx', ...placeholderRoots].sort())
  })

  it.each(screens)('%s draws its root through NativeChatSurface', (file) => {
    const text = source(file)
    expect(text).toContain('useNativeChatSurface(')
    expect(text).toContain('<NativeChatSurface ')
    for (const owned of surfaceOwned) {
      expect(text, owned).not.toContain(owned)
    }
  })

  it('the surface scopes every screen composer’s /resume; a group room opens its home workspace', () => {
    expect(source('native-chat/NativeChatSurface.tsx')).toContain(
      '<NativeChatSessionHistoryScopeContext.Provider value={surface.sessionHistory}>'
    )
    expect(source('native-chat/composer/pickers/use-native-chat-resume-command.ts')).toContain(
      'useContext(NativeChatSessionHistoryScopeContext)'
    )
    expect(source('bots/BotGroupChat.tsx')).toContain("sessionHistory: 'workspace'")
    for (const file of screens) {
      expect(source(file), file).toContain('<NativeChatComposer')
    }
  })

  it.each(transcripts)('%s scrolls its transcript in NativeChatTranscriptViewport', (file) => {
    const text = source(file)
    expect(text).toContain('<NativeChatTranscriptViewport')
    for (const owned of viewportOwned) {
      expect(text, owned).not.toContain(owned)
    }
  })
})
