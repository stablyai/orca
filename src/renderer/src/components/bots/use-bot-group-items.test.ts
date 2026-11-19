import { expect, it } from 'vitest'
import { botGroupNeedsYouOutside } from './use-bot-group-items'

it("counts a group's Needs you outside its scope only once the scoped reads have landed", () => {
  expect(botGroupNeedsYouOutside({ scoped: true, loaded: false, whole: 3, shown: 0 })).toBe(0)
  expect(botGroupNeedsYouOutside({ scoped: true, loaded: true, whole: 3, shown: 2 })).toBe(1)
  expect(botGroupNeedsYouOutside({ scoped: false, loaded: true, whole: 3, shown: 2 })).toBe(0)
})
