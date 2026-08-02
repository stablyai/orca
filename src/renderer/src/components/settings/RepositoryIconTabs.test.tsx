// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { RepositoryIconTabs } from './RepositoryIconTabs'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastMocks.error }
}))

// Mock store exposing only the theme value, to verify the minimal-selector subscription.
const storeMocks = vi.hoisted(() => ({
  state: { settings: { theme: 'light' } } as Partial<AppState>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(storeMocks.state)
}))

vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => false
}))

/** Signature of the onEmojiClick callback captured by the emoji-picker-react mock. */
type MockEmojiClickHandler = (data: { emoji: string }) => void

const emojiPickerMocks = vi.hoisted(() => ({
  onEmojiClick: null as MockEmojiClickHandler | null
}))

vi.mock('emoji-picker-react', () => ({
  __esModule: true,
  default: (props: { onEmojiClick: MockEmojiClickHandler }) => {
    emojiPickerMocks.onEmojiClick = props.onEmojiClick
    return null
  },
  EmojiStyle: { NATIVE: 'native' },
  Theme: { DARK: 'dark', LIGHT: 'light' }
}))

let container: HTMLDivElement
let root: Root

/** Renders RepositoryIconTabs with default props and returns the spy callbacks. */
function renderTabs(overrides: Partial<Parameters<typeof RepositoryIconTabs>[0]> = {}) {
  const onSetIcon = vi.fn()
  const onUseGitHubAvatar = vi.fn()
  act(() => {
    root.render(
      <RepositoryIconTabs
        initialTab="emoji"
        selectedLucideName={null}
        selectedEmoji=""
        loadingGitHub={false}
        onSetIcon={onSetIcon}
        onUseGitHubAvatar={onUseGitHubAvatar}
        {...overrides}
      />
    )
  })
  return { onSetIcon, onUseGitHubAvatar }
}

describe('RepositoryIconTabs emoji picker', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    emojiPickerMocks.onEmojiClick = null
    toastMocks.error.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  it('no longer ships the hardcoded 12-emoji list', () => {
    const source = readFileSync(path.join(__dirname, 'RepositoryIconTabs.tsx'), 'utf8')
    expect(source).not.toContain('EMOJI_OPTIONS')
    expect(source).not.toContain("'🚀', '✨', '💻'")
  })

  it('renders the full native emoji picker in place of the static grid', () => {
    renderTabs()
    expect(emojiPickerMocks.onEmojiClick).not.toBeNull()
    expect(container.querySelector('.repo-icon-emoji-picker')).not.toBeNull()
  })

  it('saves a valid emoji click through the existing RepoIcon contract', () => {
    const { onSetIcon } = renderTabs()
    act(() => {
      emojiPickerMocks.onEmojiClick?.({ emoji: '🚀' })
    })
    expect(onSetIcon).toHaveBeenCalledExactlyOnceWith({ type: 'emoji', emoji: '🚀' })
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('rejects an emoji sequence over the sanitizeRepoIcon 16-char cap instead of silently dropping it', () => {
    const { onSetIcon } = renderTabs()
    // Two ZWJ family sequences back to back: valid codepoints, well over 16 UTF-16 units.
    const overlong = '👨‍👩‍👧‍👦👨‍👩‍👧‍👦'
    expect(overlong.length).toBeGreaterThan(16)

    act(() => {
      emojiPickerMocks.onEmojiClick?.({ emoji: overlong })
    })

    expect(onSetIcon).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledTimes(1)
  })

  it('saves a valid skin-tone emoji selection instead of blocking it for global inclusivity', () => {
    const { onSetIcon } = renderTabs()
    // Base emoji + skin-tone modifier: well within the 16 UTF-16 unit cap.
    const thumbsUpMediumSkinTone = '👍🏽'
    expect(thumbsUpMediumSkinTone.length).toBeLessThanOrEqual(16)

    act(() => {
      emojiPickerMocks.onEmojiClick?.({ emoji: thumbsUpMediumSkinTone })
    })

    expect(onSetIcon).toHaveBeenCalledExactlyOnceWith({
      type: 'emoji',
      emoji: thumbsUpMediumSkinTone
    })
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('shows the currently selected emoji as trailing metadata', () => {
    renderTabs({ selectedEmoji: '🎨' })
    expect(container.textContent).toContain('🎨')
  })
})
