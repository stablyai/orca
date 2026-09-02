import type { GrokStartupTraceChunk } from './grok-startup-pty-trace'

/**
 * Recorded PTY output of `grok --no-alt-screen`, grok's inline (non
 * alternate-screen) rendering mode — also reachable via `--minimal` and
 * `[ui] screen_mode = "minimal"` in ~/.grok/config.toml.
 *
 * Recorded from: grok 1.0.0 (3cd0d0cbcebe) [stable] on macOS (darwin 25.3.0),
 * xterm-256color 120x30 via node-pty, cwd = an Orca git worktree, 10s of output
 * from spawn.
 *
 * This mode emits NO alternate-screen switch, so the composer-glyph marker never
 * anchors and the 2004-anchored quiet window is the only delivery path. Elision
 * follows the alt-screen fixture: entries without `data` are marker-free render
 * frames kept only as timestamp + byte count.
 */
export const GROK_INLINE_STARTUP_PTY_TRACE: GrokStartupTraceChunk[] = [
  {
    t: 279,
    data: '\u001b]0;grok\u0007\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1015h\u001b[?1006h\u001b[?1004h\u001b[?2004h\u001b[?25l\u001b]12;rgb:c8/c8'
  },
  { t: 279, bytes: 8 },
  { t: 2280, bytes: 11 },
  { t: 2587, bytes: 5 },
  { t: 2612, bytes: 825 },
  { t: 2612, bytes: 925 },
  { t: 2612, bytes: 928 },
  { t: 2612, bytes: 958 },
  { t: 2612, bytes: 810 },
  { t: 2613, bytes: 1000 },
  {
    t: 2613,
    data: ';80;80;88;48;2;20;20;20m╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮\u001b[39;48;2;20;20;20m  \u001b[26;1H  \u001b[38;2;80;80;88;48;2;20;20;20m│\u001b[38;2;225;225;225;48;2;20;20;20m \u001b[38;2;200;200;200;48;2;20;20;20m❯ \u001b[38;2;225;225;225;48;2;20;20;20m                                                                                                               \u001b[38;2;80;80;88;48;2;20;20;20m│\u001b[39;48;2;20;20;20m  \u001b[27;1H  \u001b[38;2;80;80;88;48;2;20;20;20m╰─────────────────────────────────────────────────────────────────────────────── \u001b[38;2;128;128;128;48;2;20;20;20mGrok 4.'
  },
  {
    t: 2613,
    data: '5 (high)\u001b[38;2;88;88;88;48;2;20;20;20m · \u001b[38;2;108;108;108;48;2;20;20;20malways-approve\u001b[38;2;80;80;88;48;2;20;20;20m ─╯\u001b[39;48;2;20;20;20m  \u001b[28;1H                                                                                                                        \u001b[29;1H                                                                                                              \u001b[38;2;108;108;108;48;2;20;20;20m[stable]\u001b[39;48;2;20;20;20m  \u001b[30;1H                                                                                                                        \u001b[39m\u001b[49m\u001b[59m\u001b[0m\u001b[26;7H\u001b[?25h\u001b[?2026l'
  },
  { t: 2614, bytes: 169 },
  { t: 2676, bytes: 158 },
  { t: 2697, bytes: 158 },
  { t: 2772, bytes: 586 },
  { t: 2781, bytes: 410 },
  { t: 2866, bytes: 971 },
  { t: 2866, bytes: 69 },
  { t: 2878, bytes: 970 },
  { t: 2878, bytes: 308 },
  { t: 2951, bytes: 970 },
  { t: 2951, bytes: 784 },
  { t: 3036, bytes: 970 },
  { t: 3036, bytes: 968 },
  { t: 3036, bytes: 417 },
  { t: 3121, bytes: 948 },
  { t: 3121, bytes: 954 },
  { t: 3121, bytes: 792 },
  { t: 3207, bytes: 966 },
  { t: 3207, bytes: 964 },
  { t: 3207, bytes: 837 },
  { t: 3291, bytes: 970 },
  { t: 3291, bytes: 966 },
  { t: 3291, bytes: 956 },
  { t: 3291, bytes: 195 },
  { t: 3376, bytes: 968 },
  { t: 3376, bytes: 962 },
  { t: 3376, bytes: 785 },
  { t: 3461, bytes: 944 },
  { t: 3461, bytes: 912 },
  { t: 3461, bytes: 79 },
  { t: 3546, bytes: 962 },
  { t: 3546, bytes: 568 },
  { t: 3630, bytes: 839 },
  { t: 3630, bytes: 40 },
  { t: 3715, bytes: 424 },
  { t: 3800, bytes: 168 },
  { t: 3885, bytes: 218 },
  { t: 4139, bytes: 219 },
  { t: 4394, bytes: 219 },
  { t: 4732, bytes: 219 },
  { t: 5582, bytes: 219 },
  { t: 5922, bytes: 219 },
  { t: 6177, bytes: 219 },
  { t: 6432, bytes: 219 },
  { t: 6602, bytes: 219 },
  { t: 6686, bytes: 158 },
  { t: 6771, bytes: 410 },
  { t: 6857, bytes: 878 },
  { t: 6857, bytes: 463 },
  { t: 6941, bytes: 970 },
  { t: 6941, bytes: 718 },
  { t: 7026, bytes: 970 },
  { t: 7026, bytes: 968 },
  { t: 7026, bytes: 292 },
  { t: 7110, bytes: 964 },
  { t: 7110, bytes: 962 },
  { t: 7110, bytes: 549 },
  { t: 7195, bytes: 964 },
  { t: 7195, bytes: 969 },
  { t: 7195, bytes: 967 },
  { t: 7195, bytes: 306 },
  { t: 7279, bytes: 970 },
  { t: 7279, bytes: 968 },
  { t: 7279, bytes: 961 },
  { t: 7279, bytes: 103 },
  { t: 7364, bytes: 968 },
  { t: 7364, bytes: 956 },
  { t: 7364, bytes: 795 },
  { t: 7449, bytes: 964 },
  { t: 7450, bytes: 962 },
  { t: 7450, bytes: 316 },
  { t: 7535, bytes: 954 },
  { t: 7535, bytes: 550 },
  { t: 7621, bytes: 960 },
  { t: 7621, bytes: 94 },
  { t: 7704, bytes: 438 },
  { t: 7789, bytes: 168 },
  { t: 7874, bytes: 83 },
  { t: 8043, bytes: 219 },
  { t: 8381, bytes: 219 },
  { t: 8635, bytes: 219 },
  { t: 8890, bytes: 219 },
  { t: 9144, bytes: 219 },
  { t: 9398, bytes: 219 },
  { t: 9738, bytes: 219 }
]
