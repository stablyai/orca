// SGR escape helpers — keep tiny and local; xterm interprets these as ANSI.
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const ITALIC = '\x1b[3m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const MAGENTA = '\x1b[35m'
const CYAN = '\x1b[36m'
const BG_GREEN = '\x1b[42m'
const FG_BLACK = '\x1b[30m'

function prompt(): string {
  // Why: short two-segment prompt — cwd + branch — so the preview reads as a
  // real shell line without using too many columns.
  return `${BLUE}~/orca${RESET} ${MAGENTA}main${RESET} ${YELLOW}*${RESET} $ `
}

// Why: every line must fit in PREVIEW_COLS (see TerminalSettingsPreview) so
// xterm doesn't wrap mid-content at the default 14px font. Longest visible
// line below is the def total signature at 32 chars.
const lines: string[] = [
  `${prompt()}npm test`,
  ` ${BG_GREEN}${FG_BLACK} PASS ${RESET} src/preview.test.ts`,
  ` ${GREEN}✓${RESET} renders sample output ${DIM}(3ms)${RESET}`,
  ` ${RED}✗ ligatures: => != >= <= ===${RESET}`,
  ``,
  `${YELLOW}def${RESET} ${CYAN}total${RESET}(xs: list[${CYAN}int${RESET}]) -> ${CYAN}int${RESET}:`,
  `    ${ITALIC}${GREEN}"""Sum the values."""${RESET}`,
  `    ${YELLOW}return${RESET} ${CYAN}sum${RESET}(x ${YELLOW}for${RESET} x ${YELLOW}in${RESET} xs)`,
  ``,
  `${prompt()}git diff`,
  `${CYAN}@@ -1,2 +1,3 @@${RESET}`,
  `${RED}-const size = 13${RESET}`,
  `${GREEN}+const size = 14${RESET}`,
  ``,
  `${prompt()}`
]

// Why: xterm interprets `\n` as line-feed only (no carriage return) by default
// for `term.write`. We need `\r\n` between visual lines so the cursor returns
// to column 0; otherwise each subsequent line starts where the previous one
// ended.
export const PREVIEW_BUFFER = lines.join('\r\n')
