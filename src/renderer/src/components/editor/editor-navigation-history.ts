import type { IPosition } from 'monaco-editor'
import type { OpenFile } from '@/store/slices/editor'

export type EditorNavigationLocation = {
  file: OpenFile
  ownerKey: string
  tabId?: string
  viewStateId?: string
  position: IPosition
  scrollTop: number
  scrollLeft: number
}

function sameEditor(a: EditorNavigationLocation, b: EditorNavigationLocation): boolean {
  return (
    a.file.id === b.file.id &&
    a.file.worktreeId === b.file.worktreeId &&
    a.ownerKey === b.ownerKey &&
    a.tabId === b.tabId &&
    a.viewStateId === b.viewStateId
  )
}

export class EditorNavigationHistory {
  private entries: EditorNavigationLocation[] = []
  private index = -1

  record(location: EditorNavigationLocation, explicitJump = false): void {
    const current = this.entries[this.index]
    if (current && sameEditor(current, location)) {
      const samePosition =
        current.position.lineNumber === location.position.lineNumber &&
        current.position.column === location.position.column
      if (
        samePosition ||
        (!explicitJump && Math.abs(current.position.lineNumber - location.position.lineNumber) < 10)
      ) {
        this.entries[this.index] = location
        return
      }
    }
    this.entries.splice(this.index + 1)
    this.entries.push(location)
    if (this.entries.length > 100) {
      this.entries.shift()
    }
    this.index = this.entries.length - 1
  }

  update(location: EditorNavigationLocation): void {
    const current = this.entries[this.index]
    if (current && sameEditor(current, location)) {
      this.entries[this.index] = location
    }
  }

  step(
    direction: 'back' | 'forward',
    canVisit: (location: EditorNavigationLocation) => boolean = () => true
  ): EditorNavigationLocation | null {
    const offset = direction === 'back' ? -1 : 1
    for (
      let index = this.index + offset;
      index >= 0 && index < this.entries.length;
      index += offset
    ) {
      const location = this.entries[index]
      if (canVisit(location)) {
        this.index = index
        return location
      }
    }
    return null
  }
}
