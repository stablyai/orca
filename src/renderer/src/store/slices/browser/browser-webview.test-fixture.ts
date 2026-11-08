import { vi } from 'vitest'

export function createWebview(overrides: Partial<Electron.WebviewTag> = {}): Electron.WebviewTag {
  return Object.assign(new EventTarget(), {
    style: {},
    blur: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn(() => false),
    ...overrides
  }) as unknown as Electron.WebviewTag
}
