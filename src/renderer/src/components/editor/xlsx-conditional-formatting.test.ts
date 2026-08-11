import { describe, expect, it } from 'vitest'
import {
  evaluateXlsxConditionalRule,
  parseXlsxConditionalFormatting,
  type XlsxConditionalRule,
  type XlsxConditionalRuleType
} from './xlsx-conditional-formatting'

function block(sqref: string, ...cfRules: string[]): string {
  return `<worksheet><conditionalFormatting sqref="${sqref}">${cfRules.join('')}</conditionalFormatting></worksheet>`
}

const NOT_CONTAINS_BLANKS_SHEET = block(
  'B27:C44 H27:H44',
  '<cfRule type="notContainsBlanks" dxfId="0" priority="1"><formula>LEN(TRIM(B27))&gt;0</formula></cfRule>'
)

const CELL_IS_LESS_THAN_SHEET = block(
  'F26:F44 L26:L44',
  '<cfRule type="cellIs" dxfId="1" priority="2" operator="lessThan"><formula>0</formula></cfRule>'
)

function rule(overrides: Partial<XlsxConditionalRule> = {}): XlsxConditionalRule {
  return {
    cells: [{ rowIndex: 0, columnIndex: 0 }],
    type: 'containsBlanks',
    formulas: [],
    differentialFormatId: 0,
    priority: 1,
    stopIfTrue: false,
    ...overrides
  }
}

function textRule(type: XlsxConditionalRuleType, needle: string): XlsxConditionalRule {
  return rule({ type, formulas: [needle] })
}

function cellIsRule(operator: string, ...formulas: string[]): XlsxConditionalRule {
  return rule({ type: 'cellIs', operator, formulas })
}

describe('parseXlsxConditionalFormatting', () => {
  it('returns nothing when the sheet declares no conditional formatting', () => {
    expect(parseXlsxConditionalFormatting('')).toEqual([])
    expect(parseXlsxConditionalFormatting('<worksheet><sheetData/></worksheet>')).toEqual([])
  })

  it('reads a multi-range blanks rule as the cells, formula and format it paints', () => {
    const rules = parseXlsxConditionalFormatting(NOT_CONTAINS_BLANKS_SHEET)

    expect(rules).toHaveLength(1)
    expect(rules[0]?.cells).toHaveLength(54)
    expect(rules[0]?.type).toBe('notContainsBlanks')
    expect(rules[0]?.formulas).toEqual(['LEN(TRIM(B27))>0'])
    expect(rules[0]?.differentialFormatId).toBe(0)
    expect(rules[0]?.priority).toBe(1)
    expect(rules[0]?.stopIfTrue).toBe(false)
  })

  it('reads a cellIs rule operator and comparand', () => {
    const rules = parseXlsxConditionalFormatting(CELL_IS_LESS_THAN_SHEET)

    expect(rules[0]?.cells).toHaveLength(38)
    expect(rules[0]?.operator).toBe('lessThan')
    expect(rules[0]?.formulas).toEqual(['0'])
  })

  it('orders the rules by ascending priority whatever order the file lists them', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'A1',
        '<cfRule type="containsBlanks" dxfId="0" priority="3"/>',
        '<cfRule type="containsBlanks" dxfId="1" priority="1"/>',
        '<cfRule type="containsBlanks" dxfId="2" priority="2"/>'
      )
    )

    expect(rules.map((parsed) => parsed.differentialFormatId)).toEqual([1, 2, 0])
  })

  it('keeps a rule with no usable priority, applying it last', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'A1',
        '<cfRule type="containsBlanks" dxfId="0"/>',
        '<cfRule type="containsBlanks" dxfId="1" priority="abc"/>',
        '<cfRule type="containsBlanks" dxfId="2" priority="5"/>'
      )
    )

    expect(rules.map((parsed) => parsed.differentialFormatId)).toEqual([2, 0, 1])
  })

  it('keeps the document order of rules that share a priority', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'A1',
        '<cfRule type="containsBlanks" dxfId="7" priority="1"/>',
        '<cfRule type="containsBlanks" dxfId="4" priority="1"/>'
      )
    )

    expect(rules.map((parsed) => parsed.differentialFormatId)).toEqual([7, 4])
  })

  it('drops a rule whose dxfId does not point at a differential format', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'A1',
        '<cfRule type="containsBlanks" priority="1"/>',
        '<cfRule type="containsBlanks" dxfId="abc" priority="2"/>',
        '<cfRule type="containsBlanks" dxfId="-1" priority="3"/>',
        '<cfRule type="containsBlanks" dxfId="0" priority="4"/>'
      )
    )

    expect(rules.map((parsed) => parsed.priority)).toEqual([4])
  })

  it('drops the rule types a viewer cannot decide and keeps their valid siblings', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'A1',
        '<cfRule dxfId="0" priority="1"/>',
        '<cfRule type="expression" dxfId="0" priority="2"><formula>A1&gt;B1</formula></cfRule>',
        '<cfRule type="colorScale" dxfId="0" priority="3"/>',
        '<cfRule type="dataBar" dxfId="0" priority="4"/>',
        '<cfRule type="iconSet" dxfId="0" priority="5"/>',
        '<cfRule type="top10" dxfId="0" priority="6"/>',
        '<cfRule type="CellIs" dxfId="0" priority="7" operator="lessThan"><formula>0</formula></cfRule>',
        '<cfRule type="containsBlanks" dxfId="0" priority="8"/>'
      )
    )

    expect(rules.map((parsed) => parsed.priority)).toEqual([8])
  })

  it('drops a block whose sqref covers nothing', () => {
    expect(
      parseXlsxConditionalFormatting(
        '<worksheet><conditionalFormatting><cfRule type="containsBlanks" dxfId="0" priority="1"/></conditionalFormatting></worksheet>'
      )
    ).toEqual([])
    expect(
      parseXlsxConditionalFormatting(block('', '<cfRule type="containsBlanks" dxfId="0"/>'))
    ).toEqual([])
  })

  it('reads stopIfTrue in both spellings a producer writes', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'A1',
        '<cfRule type="containsBlanks" dxfId="0" priority="1" stopIfTrue="1"/>',
        '<cfRule type="containsBlanks" dxfId="0" priority="2" stopIfTrue="true"/>',
        '<cfRule type="containsBlanks" dxfId="0" priority="3" stopIfTrue="0"/>',
        '<cfRule type="containsBlanks" dxfId="0" priority="4"/>'
      )
    )

    expect(rules.map((parsed) => parsed.stopIfTrue)).toEqual([true, true, false, false])
  })

  it('leaves the operator absent when the rule declares none', () => {
    const rules = parseXlsxConditionalFormatting(
      block('A1', '<cfRule type="containsBlanks" dxfId="0" priority="1"/>')
    )

    expect('operator' in rules[0]!).toBe(false)
  })

  it('reads both comparands of a between rule in document order, trimmed', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'A1',
        '<cfRule type="cellIs" dxfId="0" priority="1" operator="between"><formula> 10 </formula><formula>20</formula></cfRule>'
      )
    )

    expect(rules[0]?.formulas).toEqual(['10', '20'])
  })

  it('keeps a self-closing rule that carries no formula at all', () => {
    const rules = parseXlsxConditionalFormatting(
      block('A1', '<cfRule type="containsBlanks" dxfId="0" priority="1"/>')
    )

    expect(rules[0]?.formulas).toEqual([])
  })

  it('drops a text rule with no literal needle to test against', () => {
    // Why: a needle-less notContainsText would invert to true and repaint the
    // whole range.
    const rules = parseXlsxConditionalFormatting(
      block(
        'B27:C44',
        '<cfRule type="notContainsText" dxfId="0" priority="1"><formula>NOT(ISERROR(SEARCH(A1,B27)))</formula></cfRule>',
        '<cfRule type="notContainsText" dxfId="0" priority="2"/>'
      )
    )

    expect(rules).toEqual([])
  })

  it('takes a text rule needle from the literal inside its formula', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'B27:C44',
        '<cfRule type="notContainsText" dxfId="0" priority="1"><formula>NOT(ISERROR(SEARCH("Total",B27)))</formula></cfRule>'
      )
    )

    expect(rules[0]?.formulas).toEqual(['Total'])
  })

  it('prefers the text attribute over the literal in the formula', () => {
    const rules = parseXlsxConditionalFormatting(
      block(
        'B27:C44',
        '<cfRule type="containsText" dxfId="0" priority="1" text="Net"><formula>NOT(ISERROR(SEARCH("Total",B27)))</formula></cfRule>'
      )
    )

    expect(rules[0]?.formulas).toEqual(['Net'])
  })
})

describe('evaluateXlsxConditionalRule blanks', () => {
  it('matches a cell holding nothing but whitespace', () => {
    const blanks = rule({ type: 'containsBlanks' })

    expect(evaluateXlsxConditionalRule(blanks, { text: '' })).toBe(true)
    expect(evaluateXlsxConditionalRule(blanks, { text: '   ' })).toBe(true)
    expect(evaluateXlsxConditionalRule(blanks, { text: 'x' })).toBe(false)
  })

  it('matches the complement for notContainsBlanks', () => {
    const notBlanks = rule({ type: 'notContainsBlanks' })

    expect(evaluateXlsxConditionalRule(notBlanks, { text: 'x' })).toBe(true)
    expect(evaluateXlsxConditionalRule(notBlanks, { text: '' })).toBe(false)
    expect(evaluateXlsxConditionalRule(notBlanks, { text: '\t\n' })).toBe(false)
  })
})

describe('evaluateXlsxConditionalRule text', () => {
  it('searches for the needle regardless of case', () => {
    const contains = textRule('containsText', 'total')

    expect(evaluateXlsxConditionalRule(contains, { text: 'Grand TOTAL' })).toBe(true)
    expect(evaluateXlsxConditionalRule(contains, { text: 'Subtotals' })).toBe(true)
    expect(evaluateXlsxConditionalRule(contains, { text: 'Sum' })).toBe(false)
  })

  it('unwraps a needle the formula stored quoted', () => {
    expect(
      evaluateXlsxConditionalRule(textRule('containsText', '"Total"'), { text: 'Total' })
    ).toBe(true)
  })

  it('reads a doubled quote inside a needle as one quote', () => {
    const contains = textRule('containsText', '"a""b"')

    expect(evaluateXlsxConditionalRule(contains, { text: 'x a"b y' })).toBe(true)
    expect(evaluateXlsxConditionalRule(contains, { text: 'x a""b y' })).toBe(false)
  })

  it('inverts the search for notContainsText', () => {
    const notContains = textRule('notContainsText', 'Total')

    expect(evaluateXlsxConditionalRule(notContains, { text: 'Sum' })).toBe(true)
    expect(evaluateXlsxConditionalRule(notContains, { text: 'total row' })).toBe(false)
  })

  it('anchors beginsWith and endsWith, regardless of case', () => {
    const begins = textRule('beginsWith', 'To')
    const ends = textRule('endsWith', 'al')

    expect(evaluateXlsxConditionalRule(begins, { text: 'total' })).toBe(true)
    expect(evaluateXlsxConditionalRule(begins, { text: 'Grand total' })).toBe(false)
    expect(evaluateXlsxConditionalRule(ends, { text: 'TOTAL' })).toBe(true)
    expect(evaluateXlsxConditionalRule(ends, { text: 'totals' })).toBe(false)
  })
})

describe('evaluateXlsxConditionalRule cellIs', () => {
  it('compares a numeric cell against the threshold', () => {
    const lessThanZero = cellIsRule('lessThan', '0')

    expect(evaluateXlsxConditionalRule(lessThanZero, { text: '-1', numeric: -1 })).toBe(true)
    expect(evaluateXlsxConditionalRule(lessThanZero, { text: '0', numeric: 0 })).toBe(false)
    expect(evaluateXlsxConditionalRule(lessThanZero, { text: '1', numeric: 1 })).toBe(false)
  })

  it('leaves a cell with no number of its own alone', () => {
    const lessThanZero = cellIsRule('lessThan', '0')

    expect(evaluateXlsxConditionalRule(lessThanZero, { text: 'Pending' })).toBe(false)
    expect(evaluateXlsxConditionalRule(lessThanZero, { text: '' })).toBe(false)
  })

  it('refuses a threshold the file left empty rather than reading it as zero', () => {
    const parsed = parseXlsxConditionalFormatting(
      block(
        'A1:A2',
        '<cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula></formula></cfRule>',
        '<cfRule type="cellIs" dxfId="0" priority="2" operator="lessThan"><formula>   </formula></cfRule>'
      )
    )

    expect(parsed.map((parsedRule) => parsedRule.formulas)).toEqual([[''], ['']])
    for (const emptyThreshold of parsed) {
      expect(evaluateXlsxConditionalRule(emptyThreshold, { text: '-1', numeric: -1 })).toBe(false)
      expect(evaluateXlsxConditionalRule(emptyThreshold, { text: '0', numeric: 0 })).toBe(false)
    }
  })

  it('matches equality on the number, not on the text', () => {
    expect(
      evaluateXlsxConditionalRule(cellIsRule('equal', '5'), { text: '5.00', numeric: 5 })
    ).toBe(true)
    expect(evaluateXlsxConditionalRule(cellIsRule('equal', '5,0'), { text: '5', numeric: 5 })).toBe(
      false
    )
    expect(evaluateXlsxConditionalRule(cellIsRule('equal', '0'), { text: '0', numeric: -0 })).toBe(
      true
    )
  })

  it('reports the complement for notEqual', () => {
    expect(
      evaluateXlsxConditionalRule(cellIsRule('notEqual', '5'), { text: '6', numeric: 6 })
    ).toBe(true)
    expect(
      evaluateXlsxConditionalRule(cellIsRule('notEqual', '5'), { text: '5', numeric: 5 })
    ).toBe(false)
  })

  it('includes the boundary only for the inclusive operators', () => {
    expect(
      evaluateXlsxConditionalRule(cellIsRule('lessThanOrEqual', '0'), { text: '0', numeric: 0 })
    ).toBe(true)
    expect(
      evaluateXlsxConditionalRule(cellIsRule('lessThanOrEqual', '0'), { text: '0.1', numeric: 0.1 })
    ).toBe(false)
    expect(
      evaluateXlsxConditionalRule(cellIsRule('greaterThan', '0'), { text: '0', numeric: 0 })
    ).toBe(false)
    expect(
      evaluateXlsxConditionalRule(cellIsRule('greaterThan', '0'), { text: '0.1', numeric: 0.1 })
    ).toBe(true)
    expect(
      evaluateXlsxConditionalRule(cellIsRule('greaterThanOrEqual', '0'), { text: '0', numeric: 0 })
    ).toBe(true)
    expect(
      evaluateXlsxConditionalRule(cellIsRule('greaterThanOrEqual', '0'), {
        text: '-0.1',
        numeric: -0.1
      })
    ).toBe(false)
  })

  it('treats a between range as inclusive at both ends', () => {
    const between = cellIsRule('between', '10', '20')

    for (const numeric of [10, 15, 20]) {
      expect(evaluateXlsxConditionalRule(between, { text: `${numeric}`, numeric })).toBe(true)
    }
    expect(evaluateXlsxConditionalRule(between, { text: '9.99', numeric: 9.99 })).toBe(false)
    expect(evaluateXlsxConditionalRule(between, { text: '20.01', numeric: 20.01 })).toBe(false)
  })

  it('reads a between range written high bound first', () => {
    const reversed = cellIsRule('between', '20', '10')

    expect(evaluateXlsxConditionalRule(reversed, { text: '15', numeric: 15 })).toBe(true)
    expect(evaluateXlsxConditionalRule(reversed, { text: '21', numeric: 21 })).toBe(false)
  })

  it('refuses a between rule missing its second bound', () => {
    expect(
      evaluateXlsxConditionalRule(cellIsRule('between', '10'), { text: '15', numeric: 15 })
    ).toBe(false)
  })

  it('matches exactly outside the range for notBetween', () => {
    const notBetween = cellIsRule('notBetween', '10', '20')

    expect(evaluateXlsxConditionalRule(notBetween, { text: '9', numeric: 9 })).toBe(true)
    expect(evaluateXlsxConditionalRule(notBetween, { text: '21', numeric: 21 })).toBe(true)
    expect(evaluateXlsxConditionalRule(notBetween, { text: '10', numeric: 10 })).toBe(false)
    expect(evaluateXlsxConditionalRule(notBetween, { text: '20', numeric: 20 })).toBe(false)
  })

  it('refuses an operator it cannot decide', () => {
    expect(
      evaluateXlsxConditionalRule(rule({ type: 'cellIs', formulas: ['0'] }), {
        text: '-1',
        numeric: -1
      })
    ).toBe(false)
    expect(
      evaluateXlsxConditionalRule(cellIsRule('containsText', '0'), { text: '-1', numeric: -1 })
    ).toBe(false)
  })

  it('refuses a comparand that is not a literal number', () => {
    for (const formula of ['$A$1', 'SUM(A1:A2)', '"texto"', 'NaN', 'Infinity']) {
      expect(
        evaluateXlsxConditionalRule(cellIsRule('greaterThan', formula), { text: '5', numeric: 5 })
      ).toBe(false)
    }
  })

  it('reads a comparand in exponent notation', () => {
    expect(
      evaluateXlsxConditionalRule(cellIsRule('equal', '1e3'), { text: '1000', numeric: 1000 })
    ).toBe(true)
  })
})
