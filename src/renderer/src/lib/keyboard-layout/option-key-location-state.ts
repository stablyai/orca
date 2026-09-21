export type OptionKeyLocationState = 0 | 1 | 2 | 3

type OptionKeyEvent = {
  key: string
  location: number
}

export type OptionKeyLocationTracker = {
  keyDown: (event: OptionKeyEvent) => void
  keyUp: (event: OptionKeyEvent) => void
  clear: () => void
  get: () => OptionKeyLocationState
}

function sideBit(location: number): 1 | 2 | null {
  return location === 1 || location === 2 ? location : null
}

export function createOptionKeyLocationTracker(): OptionKeyLocationTracker {
  let held: OptionKeyLocationState = 0
  return {
    keyDown: (event) => {
      if (event.key !== 'Alt') {
        return
      }
      const side = sideBit(event.location)
      held = side === null ? 0 : ((held | side) as OptionKeyLocationState)
    },
    keyUp: (event) => {
      if (event.key !== 'Alt') {
        return
      }
      const side = sideBit(event.location)
      held = side === null ? 0 : ((held & ~side) as OptionKeyLocationState)
    },
    clear: () => {
      held = 0
    },
    get: () => held
  }
}
