/**
 * Recorded PTY output of a bare `copilot` launch, used to pin when the draft-paste readiness
 * scanner delivers a launch draft.
 *
 * Recorded from: GitHub Copilot CLI 1.0.107 on macOS (darwin 25.3.0), xterm-256color 120x40,
 * 12s of output from spawn. Paths and branch names are anonymized; timings are verbatim.
 * `COPILOT_STARTUP_PTY_TRACE` ran in a trusted git worktree: the composer row lands at 2368ms,
 * then the loading spinner and mascot repaint until 4083ms and the mascot blinks again at 9.5s.
 * `COPILOT_TRUST_MENU_PTY_TRACE` ran in an untrusted folder and stays on the trust menu.
 */
export type CopilotStartupTraceChunk = { t: number; data: string }

export const COPILOT_STARTUP_PTY_TRACE: CopilotStartupTraceChunk[] = [
  { t: 1819, data: '\u001b[>4;2m\u001b[?u' },
  { t: 1819, data: '\u001b[?2026$p' },
  {
    t: 1819,
    data: '\u001b[?1049h\u001b[?2004h\u001b[?1004h\u001b[?1003h\u001b[?1006h\u001b[?25l\u001b[?12$p'
  },
  { t: 1819, data: '\u001b[?1007$p' },
  { t: 1821, data: '\u001b[c\u001b[H\u001b[2J' },
  { t: 1821, data: '\u001b[>q' },
  { t: 1821, data: '\u001b[14t' },
  { t: 1821, data: '\u001b]10;?\u001b\\' },
  { t: 1821, data: '\u001b]11;?\u001b\\' },
  { t: 1822, data: '\u001b]4;0;?\u001b\\' },
  { t: 1822, data: '\u001b]4;1;?\u001b\\' },
  { t: 1822, data: '\u001b]4;2;?\u001b\\\u001b]4;3;?\u001b\\' },
  { t: 1822, data: '\u001b]4;4;?\u001b\\' },
  { t: 1822, data: '\u001b]4;5;?\u001b\\' },
  { t: 1822, data: '\u001b]4;6;?\u001b\\' },
  { t: 1822, data: '\u001b]4;7;?\u001b\\' },
  { t: 1822, data: '\u001b]4;8;?\u001b\\' },
  { t: 1822, data: '\u001b]4;9;?\u001b\\' },
  { t: 1822, data: '\u001b]4;10;?\u001b\\\u001b]4;11;?\u001b\\\u001b]4;12;?\u001b\\' },
  { t: 1822, data: '\u001b]4;13;?\u001b\\' },
  { t: 1822, data: '\u001b]4;14;?\u001b\\' },
  { t: 1822, data: '\u001b]4;15;?\u001b\\' },
  { t: 1866, data: '\u001b[?25l' },
  { t: 1869, data: '\u001b[22;0t\u001b]0;GitHub Copilot\u0007' },
  { t: 1902, data: '\u001b]7501;state=idle:app=copilot\u001b\\' },
  {
    t: 1921,
    data: '\u001b[H\u001b[2J \u001b[1;97;44m[Current]\u001b[m  Sessions  \u001b[2m Issues \u001b[m \u001b[2m Pull requests \u001b[m  Gists'
  },
  { t: 1930, data: '\u001b[?996n' },
  {
    t: 1965,
    data: '\r\n\r\n\u001b[2;90m╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮\r\n│\u001b[116C│\r\n│\u001b[m \u001b[34m ╭─╮╭─╮\u001b[5;39H\u001b[2;90m│\u001b[m  \u001b[1;34mGetting started\u001b[61C\u001b[0;2;90m│\r\n│\u001b[m \u001b[34m ╰─╯╰─╯\u001b[m  Copilot v1.0.107 uses AI.  \u001b[2;90m│\u001b[m  Use the tabs above to explore your sessions and pull requests\u001b[15C\u001b[2;90m│\r\n│\u001b[m \u001b[35m █ \u001b[96m▘▝\u001b[35m █\u001b[m  Check for mistakes.\u001b[7;39H\u001b[2;90m│\u001b[m  /init — Initialize Copilot instructions for this repository\u001b[17C\u001b[2;90m│\r\n│\u001b[m \u001b[35m  ▔▔▔▔ \u001b[8;39H\u001b[2;90m│\u001b[m  /model — Switch models across providers, or use Auto\u001b[24C\u001b[2;90m│\r\n│\u001b[116C│\r\n╰───────────────────────────────�'
  },
  {
    t: 1965,
    data: '�────────────────────────────────────────────────────────────────────────────────────╯\u001b[m'
  },
  {
    t: 2368,
    data: '\u001b[1;23H Issues   Pull requests \u001b[36;2H~/src/repo\u001b[36;101HSession: 0 AIC used\r\n\u001b[2m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\r\n\u001b[m❯\r\n\u001b[2m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\r\r\n\u001b[C\u001b[0;94m●\u001b[m \u001b[94mL\u001b[34moading: 1 instruction, 13 hooks\u001b[40;92H\u001b[mCopilot Fusion · hydrafusion\u001b[38;3H\u001b[?25h'
  },
  {
    t: 2402,
    data: '\u001b[?25l\u001b[36;46H[⎇ feature/branch]\u001b[40;36H\u001b[34m, 77 skills\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 2554,
    data: '\u001b[?25l\r\n\r\n \u001b[94m◉\u001b[m \u001b[34mLo\u001b[94mad\u001b[m\u001b[38;3H\u001b[?25h'
  },
  { t: 2618, data: '\u001b[?25l\u001b[40;92H       Copilot Fusion · High\u001b[38;3H\u001b[?25h' },
  {
    t: 2651,
    data: '\u001b[?25l\u001b[8;90HCopilot Fusion\u001b[40;2H\u001b[34m◎\u001b[m \u001b[94mL\u001b[34moadi\u001b[94mng\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 2747,
    data: '\u001b[?25l\u001b[7;6H\u001b[96m╴╶\u001b[35m \u001b[40;2H\u001b[34m○\u001b[m \u001b[34mLo\u001b[94mad\u001b[34ming:\u001b[94m 1\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 2828,
    data: '\u001b[?25l\u001b[7;6H\u001b[96m  \u001b[35m \u001b[40;2H\u001b[34m◎\u001b[m \u001b[34mLoadi\u001b[94mng\u001b[34m: 1 \u001b[94min\u001b[m\u001b[38;3H\u001b[?25h'
  },
  { t: 2862, data: '\u001b[?25l\u001b[7;6H\u001b[96m╴╶\u001b[35m \u001b[m\u001b[38;3H\u001b[?25h' },
  {
    t: 2918,
    data: '\u001b[?25l\r\n\r\n \u001b[34m◉\u001b[6Cng:\u001b[94m 1\u001b[34m ins\u001b[94mtr\u001b[m\u001b[38;3H\u001b[?25h'
  },
  { t: 2953, data: '\u001b[?25l\u001b[7;6H\u001b[96m▘▝\u001b[35m \u001b[m\u001b[38;3H\u001b[?25h' },
  {
    t: 3024,
    data: '\u001b[?25l\r\n\r\n \u001b[94m●\u001b[40;12H\u001b[34m 1 \u001b[94min\u001b[34mstru\u001b[94mct\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 3122,
    data: '\u001b[?25l\r\n\r\n \u001b[94m◉\u001b[40;15H\u001b[34mins\u001b[94mtr\u001b[34mucti\u001b[94mon\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 3251,
    data: '\u001b[?25l\r\n\r\n \u001b[94m●\u001b[m \u001b[94mL\u001b[40;18H\u001b[34mtruction\u001b[40;47H, 1 MCP server\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 3399,
    data: '\u001b[?25l\r\n\r\n \u001b[94m◉\u001b[m \u001b[34mLo\u001b[94mad\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 3491,
    data: '\u001b[?25l\r\n\r\n \u001b[34m◎\u001b[m \u001b[94mL\u001b[34moadi\u001b[94mng\u001b[m\u001b[38;3H\u001b[?25h'
  },
  { t: 3557, data: '\u001b[?25l\u001b[7;6H\u001b[96m╴╶\u001b[35m \u001b[m\u001b[38;3H\u001b[?25h' },
  {
    t: 3591,
    data: '\u001b[?25l\r\n\r\n \u001b[34m○\u001b[m \u001b[34mLo\u001b[94mad\u001b[34ming:\u001b[94m 1\u001b[m\u001b[38;3H\u001b[?25h'
  },
  { t: 3625, data: '\u001b[?25l\u001b[7;6H\u001b[96m  \u001b[35m \u001b[m\u001b[38;3H\u001b[?25h' },
  {
    t: 3691,
    data: '\u001b[?25l\u001b[7;6H\u001b[96m╴╶\u001b[35m \u001b[40;2H\u001b[34m◎\u001b[m \u001b[34mLoadi\u001b[94mng\u001b[34m: 1 \u001b[94min\u001b[m\u001b[38;3H\u001b[?25h'
  },
  { t: 3761, data: '\u001b[?25l\u001b[7;6H\u001b[96m▘▝\u001b[35m \u001b[m\u001b[38;3H\u001b[?25h' },
  {
    t: 3794,
    data: '\u001b[?25l\r\n\r\n \u001b[34m◉\u001b[6Cng:\u001b[94m 1\u001b[34m ins\u001b[94mtr\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 3861,
    data: '\u001b[?25l\u001b[7;6H\u001b[96m╴╶\u001b[35m \u001b[40;2H\u001b[0;1m←\u001b[m open sidebar · Interactive · Manual Approval · \u001b[1m/\u001b[m commands · \u001b[1m?\u001b[m help · \u001b[1mtab\u001b[m next tab\u001b[38;3H\u001b[?25h'
  },
  { t: 3928, data: '\u001b[?25l\u001b[7;6H\u001b[96m  \u001b[35m \u001b[m\u001b[38;3H\u001b[?25h' },
  {
    t: 3962,
    data: '\u001b[?25l\u001b[26A\b\u001b[34m●\u001b[m MCP Servers reloaded: 2 servers connected\u001b[38;3H\u001b[?25h'
  },
  { t: 3997, data: '\u001b[?25l\u001b[7;6H\u001b[96m╴╶\u001b[35m \u001b[m\u001b[38;3H\u001b[?25h' },
  { t: 4083, data: '\u001b[?25l\u001b[7;6H\u001b[96m▘▝\u001b[35m \u001b[m\u001b[38;3H\u001b[?25h' },
  {
    t: 9502,
    data: '\u001b[?25l\u001b[5;6H\u001b[34m─╮╭╮\r\n\u001b[5C─╯╰╯\r\n\u001b[4C\u001b[35m█ \u001b[96m▘▝\u001b[35m▐\r\n\u001b[4C ▔\u001b[m\u001b[38;3H\u001b[?25h'
  },
  {
    t: 10604,
    data: '\u001b[?25l\u001b[5;6H\u001b[34m╮╭─╮\r\n\u001b[5C╯╰─╯\r\n\u001b[4C\u001b[35m \u001b[96m▘▝\u001b[35m █\r\n\u001b[4C▔▔\u001b[m\u001b[38;3H\u001b[?25h'
  }
]

export const COPILOT_TRUST_MENU_PTY_TRACE: CopilotStartupTraceChunk[] = [
  { t: 386, data: '\u001b[>4;2m\u001b[?u' },
  { t: 387, data: '\u001b[?2026$p' },
  {
    t: 387,
    data: '\u001b[?1049h\u001b[?2004h\u001b[?1004h\u001b[?1003h\u001b[?1006h\u001b[?25l\u001b[?12$p'
  },
  { t: 387, data: '\u001b[?1007$p' },
  { t: 388, data: '\u001b[c\u001b[H\u001b[2J' },
  { t: 388, data: '\u001b[>q' },
  { t: 389, data: '\u001b[14t' },
  { t: 389, data: '\u001b]10;?\u001b\\' },
  { t: 389, data: '\u001b]11;?\u001b\\' },
  { t: 389, data: '\u001b]4;0;?\u001b\\' },
  { t: 389, data: '\u001b]4;1;?\u001b\\' },
  {
    t: 389,
    data: '\u001b]4;2;?\u001b\\\u001b]4;3;?\u001b\\\u001b]4;4;?\u001b\\\u001b]4;5;?\u001b\\\u001b]4;6;?\u001b\\\u001b]4;7;?\u001b\\'
  },
  { t: 389, data: '\u001b]4;8;?\u001b\\' },
  { t: 389, data: '\u001b]4;9;?\u001b\\' },
  { t: 389, data: '\u001b]4;10;?\u001b\\' },
  { t: 389, data: '\u001b]4;11;?\u001b\\' },
  { t: 389, data: '\u001b]4;12;?\u001b\\' },
  { t: 389, data: '\u001b]4;13;?\u001b\\' },
  { t: 389, data: '\u001b]4;14;?\u001b\\' },
  { t: 389, data: '\u001b]4;15;?\u001b\\' },
  { t: 432, data: '\u001b[?25l' },
  { t: 435, data: '\u001b[22;0t\u001b]0;GitHub Copilot\u0007' },
  { t: 458, data: '\u001b]7501;state=idle:app=copilot\u001b\\' },
  {
    t: 473,
    data: '\u001b[H\u001b[2J \u001b[1;97;44m[Current]\u001b[m  Sessions  \u001b[2m Issues \u001b[m \u001b[2m Pull requests \u001b[m  Gists'
  },
  { t: 479, data: '\u001b[?996n' },
  {
    t: 516,
    data: '\r\n\r\n\u001b[2;90m╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮\r\n│\u001b[116C│\r\n│\u001b[m \u001b[34m ╭─╮╭─╮\u001b[5;39H\u001b[2;90m│\u001b[m  \u001b[1;34mGetting started\u001b[61C\u001b[0;2;90m│\r\n│\u001b[m \u001b[34m ╰─╯╰─╯\u001b[m  Copilot v1.0.107 uses AI.  \u001b[2;90m│\u001b[m  Use the tabs above to explore your sessions and pull requests\u001b[15C\u001b[2;90m│\r\n│\u001b[m \u001b[35m █ \u001b[96m▘▝\u001b[35m █\u001b[m  Check for mistakes.\u001b[7;39H\u001b[2;90m│\u001b[m  /init — Initialize Copilot instructions for this repository\u001b[17C\u001b[2;90m│\r\n│\u001b[m \u001b[35m  ▔▔▔▔ \u001b[8;39H\u001b[2;90m│\u001b[m  /model — Switch models across providers, or use Auto\u001b[24C\u001b[2;90m│\r\n│\u001b[116C│\r\n╰───────────────────────────────�'
  },
  {
    t: 516,
    data: '�────────────────────────────────────────────────────────────────────────────────────╯\u001b[m'
  },
  {
    t: 552,
    data: '\r\u001b[10B\u001b[90m╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮\r\r\n│\u001b[m \u001b[1mConfirm folder trust\u001b[97C\u001b[0;90m│\r\r\n│\u001b[m \u001b[90m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[m \u001b[90m│\r\r\n│\u001b[m \u001b[90m╭──────────────────────────────────────────────────────────────────────�'
  },
  {
    t: 552,
    data: '��───────────────────────────────────────────╮\u001b[m \u001b[90m│\r\r\n│\u001b[m \u001b[90m│\u001b[m /private/tmp/untrusted-ws\u001b[88C\u001b[90m│\u001b[m \u001b[90m│\r\r\n│\u001b[m \u001b[90m╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯\u001b[m \u001b[90m│\r\r\n│\u001b[118C│\r\r\n│\u001b[m Copilot can read files in this folder and, with your permission, edit them or run code and shell commands. It will   \u001b[90m│\r\r\n│\u001b[m remember your permissions for the rest of this session.\u001b[62C\u001b[90m│\r\r\n│\u001b[118C│\r\r\n│\u001b[m Git commands run in this folder may use configuration from the enclosing repository and execute programs configured  \u001b[90m│\r\r\n│\u001b[m by that repository.\u001b[98C\u001b[90m│\r\r\n│\u001b[118'
  },
  {
    t: 552,
    data: 'C│\r\r\n│\u001b[m Do you trust the files in this folder?\u001b[79C\u001b[90m│\r\r\n│\u001b[118C│\r\r\n│\u001b[m \u001b[97;44m❯ 1. Yes\u001b[39m                                                                                                            \u001b[m \u001b[90m│\r\r\n│\u001b[m   2. Yes, and remember this folder for future sessions\u001b[63C\u001b[90m│\r\r\n│\u001b[m   3. No (Esc)\u001b[104C\u001b[90m│\r\r\n│\u001b[118C│\r\r\n│\u001b[m \u001b[1m↑/↓\u001b[m to navigate · \u001b[1menter\u001b[m to select · \u001b[1mesc\u001b[m to cancel\u001b[68C\u001b[90m│\r\r\n╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[?7l╯\u001b[?7h\u001b[m'
  },
  { t: 1177, data: '\u001b[8;90HCopilot Fusion' },
  { t: 1292, data: '\u001b[7;6H\u001b[96m╴╶\u001b[35m \u001b[m' },
  {
    t: 1371,
    data: '\b\b\b\u001b[96m  \u001b[35m \u001b[12;2H\u001b[34m●\u001b[m MCP Servers reloaded: 1 server connected'
  },
  { t: 1436, data: '\u001b[7;6H\u001b[96m╴╶\u001b[35m \u001b[m' },
  { t: 1508, data: '\b\b\b\u001b[96m▘▝\u001b[35m \u001b[m' },
  { t: 2109, data: '\b\b\b\u001b[96m╴╶\u001b[35m \u001b[m' },
  { t: 2185, data: '\b\b\b\u001b[96m  \u001b[35m \u001b[m' },
  { t: 2219, data: '\b\b\b\u001b[96m╴╶\u001b[35m \u001b[m' },
  { t: 2312, data: '\b\b\b\u001b[96m▘▝\u001b[35m \u001b[m' },
  { t: 2427, data: '\b\b\b\u001b[96m╴╶\u001b[35m \u001b[m' },
  { t: 2500, data: '\b\b\b\u001b[96m  \u001b[35m \u001b[m' },
  { t: 2533, data: '\b\b\b\u001b[96m╴╶\u001b[35m \u001b[m' },
  { t: 2633, data: '\b\b\b\u001b[96m▘▝\u001b[35m \u001b[m' },
  { t: 6842, data: '\b\b\b\u001b[96m╴╶\u001b[35m \u001b[m' },
  { t: 6910, data: '\b\b\b\u001b[96m  \u001b[35m \u001b[m' },
  { t: 6942, data: '\b\b\b\u001b[96m╴╶\u001b[35m \u001b[m' },
  { t: 7042, data: '\b\b\b\u001b[96m▘▝\u001b[35m \u001b[m' },
  { t: 11911, data: '\b\b\b\u001b[96m╴╶\u001b[35m \u001b[m' },
  { t: 11981, data: '\b\b\b\u001b[96m  \u001b[35m \u001b[m' },
  { t: 12014, data: '\b\b\b\u001b[96m╴╶\u001b[35m \u001b[m' }
]
