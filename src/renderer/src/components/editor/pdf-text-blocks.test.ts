import { describe, expect, it } from 'vitest'
import { paragraphRunIndexes, type TextBox } from './pdf-text-blocks'

// 10px-tall lines on a 12px pitch, column from x=100 to x=400, like a LaTeX article page.
function line(row: number, left = 100, right = 400, top = 0): TextBox {
  return { left, right, top: top + row * 12, bottom: top + row * 12 + 10 }
}

const page: TextBox[] = [
  line(0, 100, 220), //          0: "1 Introduction" (heading, short)
  line(2), //                    1: paragraph 1, line 1 (after a tall gap)
  line(3), //                    2: paragraph 1, line 2
  line(4), //                    3: paragraph 1, line 3
  line(5, 100, 140), //          4: paragraph 1, last line "ends."
  line(6, 115, 400), //          5: paragraph 2, indented first line
  line(7, 100, 330), //          6: paragraph 2, last line before the equation
  line(9, 200, 300), //          7: centred display equation
  line(11, 100, 300) //          8: text after the equation
]

describe('paragraphRunIndexes', () => {
  it('selects the whole paragraph from any of its lines', () => {
    expect(paragraphRunIndexes(page, 1)).toEqual([1, 2, 3, 4])
    expect(paragraphRunIndexes(page, 3)).toEqual([1, 2, 3, 4])
    expect(paragraphRunIndexes(page, 4)).toEqual([1, 2, 3, 4])
  })

  it('starts a new paragraph at an indented first line', () => {
    expect(paragraphRunIndexes(page, 5)).toEqual([5, 6])
  })

  it('keeps headings and display equations as their own blocks', () => {
    expect(paragraphRunIndexes(page, 0)).toEqual([0])
    expect(paragraphRunIndexes(page, 7)).toEqual([7])
  })

  it('joins runs that share a line', () => {
    const split = [...page.slice(0, 2), { ...line(2), right: 250 }, { ...line(2), left: 255 }]
    split.splice(1, 1)
    expect(paragraphRunIndexes(split, 2).sort()).toEqual([1, 2])
  })

  it('does not cross into the other column', () => {
    const twoColumn = [line(0, 100, 240), line(1, 100, 240), line(0, 260, 400), line(1, 260, 400)]
    expect(paragraphRunIndexes(twoColumn, 0)).toEqual([0, 1])
    expect(paragraphRunIndexes(twoColumn, 3)).toEqual([2, 3])
  })

  it('accepts DOMRect-like boxes whose edges are prototype getters', () => {
    class GetterBox {
      constructor(private readonly box: TextBox) {}
      get left(): number {
        return this.box.left
      }
      get top(): number {
        return this.box.top
      }
      get right(): number {
        return this.box.right
      }
      get bottom(): number {
        return this.box.bottom
      }
    }
    expect(
      paragraphRunIndexes(
        page.map((box) => new GetterBox(box)),
        2
      )
    ).toEqual([1, 2, 3, 4])
  })
})
