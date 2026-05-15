import React from 'react'
import { ClaudeIcon, DroidIcon, OpenAIIcon } from '@/components/status-bar/icons'
import type { TuiAgent } from '../../../shared/types'

export type AgentCatalogEntry = {
  id: TuiAgent
  label: string
  /** Default CLI binary name used for PATH detection. */
  cmd: string
  /** Domain for Google's favicon service — used for agents without an SVG icon. */
  faviconDomain?: string
  /** Homepage/install docs URL, sourced from the README agent badge list. */
  homepageUrl: string
}

// Full catalog of supported agents — ordered by priority for auto-default selection.
// homepageUrl matches the href used in the README agent badge list.
export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    id: 'claude',
    label: 'Claude',
    cmd: 'claude',
    homepageUrl: 'https://docs.anthropic.com/claude/docs/claude-code'
  },
  {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    homepageUrl: 'https://github.com/openai/codex'
  },
  {
    id: 'grok',
    label: 'Grok',
    cmd: 'grok',
    faviconDomain: 'x.ai',
    homepageUrl: 'https://x.ai/cli'
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    cmd: 'copilot',
    faviconDomain: 'github.com',
    homepageUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    cmd: 'opencode',
    faviconDomain: 'opencode.ai',
    homepageUrl: 'https://opencode.ai/docs/cli/'
  },
  {
    id: 'pi',
    label: 'Pi',
    cmd: 'pi',
    homepageUrl: 'https://pi.dev'
  },
  {
    id: 'gemini',
    label: 'Gemini',
    cmd: 'gemini',
    faviconDomain: 'gemini.google.com',
    homepageUrl: 'https://github.com/google-gemini/gemini-cli'
  },
  {
    id: 'aider',
    label: 'Aider',
    cmd: 'aider',
    homepageUrl: 'https://aider.chat/docs/'
  },
  {
    id: 'goose',
    label: 'Goose',
    cmd: 'goose',
    faviconDomain: 'goose-docs.ai',
    homepageUrl: 'https://block.github.io/goose/docs/quickstart/'
  },
  {
    id: 'amp',
    label: 'Amp',
    cmd: 'amp',
    faviconDomain: 'ampcode.com',
    homepageUrl: 'https://ampcode.com/manual#install'
  },
  {
    id: 'kilo',
    label: 'Kilocode',
    cmd: 'kilo',
    homepageUrl: 'https://kilo.ai/docs/cli'
  },
  {
    id: 'kiro',
    label: 'Kiro',
    // Why: the Kiro installer (https://cli.kiro.dev/install) ships a binary
    // named `kiro-cli`, not `kiro`. Match TUI_AGENT_CONFIG.kiro.detectCmd so
    // the settings pane's "default command" hint aligns with what Orca
    // actually looks for on PATH.
    cmd: 'kiro-cli',
    faviconDomain: 'kiro.dev',
    homepageUrl: 'https://kiro.dev/docs/cli/'
  },
  {
    id: 'crush',
    label: 'Charm',
    cmd: 'crush',
    faviconDomain: 'charm.sh',
    homepageUrl: 'https://github.com/charmbracelet/crush'
  },
  {
    id: 'aug',
    label: 'Auggie',
    cmd: 'auggie',
    faviconDomain: 'augmentcode.com',
    homepageUrl: 'https://docs.augmentcode.com/cli/overview'
  },
  {
    id: 'autohand',
    label: 'Autohand Code',
    cmd: 'autohand',
    faviconDomain: 'autohand.ai',
    homepageUrl: 'https://github.com/autohandai/code-cli'
  },
  {
    id: 'cline',
    label: 'Cline',
    cmd: 'cline',
    faviconDomain: 'cline.bot',
    homepageUrl: 'https://docs.cline.bot/cline-cli/overview'
  },
  {
    id: 'codebuff',
    label: 'Codebuff',
    cmd: 'codebuff',
    faviconDomain: 'codebuff.com',
    homepageUrl: 'https://www.codebuff.com/docs/help/quick-start'
  },
  {
    id: 'continue',
    label: 'Continue',
    cmd: 'continue',
    faviconDomain: 'continue.dev',
    homepageUrl: 'https://docs.continue.dev/guides/cli'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    cmd: 'cursor-agent',
    faviconDomain: 'cursor.com',
    homepageUrl: 'https://cursor.com/cli'
  },
  {
    id: 'droid',
    label: 'Droid',
    cmd: 'droid',
    homepageUrl: 'https://docs.factory.ai/cli/getting-started/quickstart'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    cmd: 'kimi',
    faviconDomain: 'moonshot.cn',
    homepageUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html'
  },
  {
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    cmd: 'mistral-vibe',
    faviconDomain: 'mistral.ai',
    homepageUrl: 'https://github.com/mistralai/mistral-vibe'
  },
  {
    id: 'qwen-code',
    label: 'Qwen Code',
    cmd: 'qwen-code',
    faviconDomain: 'qwenlm.github.io',
    homepageUrl: 'https://github.com/QwenLM/qwen-code'
  },
  {
    id: 'rovo',
    label: 'Rovo Dev',
    cmd: 'rovo',
    faviconDomain: 'atlassian.com',
    homepageUrl:
      'https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/'
  },
  {
    id: 'hermes',
    label: 'Hermes',
    cmd: 'hermes',
    faviconDomain: 'nousresearch.com',
    homepageUrl: 'https://hermes-agent.nousresearch.com/docs/'
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    cmd: 'openclaw',
    faviconDomain: 'openclaw.ai',
    homepageUrl: 'https://github.com/openclaw/openclaw'
  }
]

function PiIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  // SVG sourced from pi.dev/favicon.svg — the π shape rendered in currentColor.
  // Why: className="text-current" opts out of shadcn's Select rule that forces
  // text-muted-foreground on any <svg> that lacks a text-* class.
  return (
    <svg
      height={size}
      width={size}
      viewBox="0 0 800 800"
      xmlns="http://www.w3.org/2000/svg"
      className="text-current"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  )
}

function KiloIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  // SVG sourced from Kilo-Org/kilocode:packages/kilo-vscode/assets/icons/kilo-light.svg.
  // Why: the Google favicon for kilo.ai is black-on-black at small sizes and
  // is illegible. Inlining the brand mark (yellow on black) keeps it readable
  // on both light and dark app themes without using currentColor — this logo
  // is intentionally brand-colored, not theme-colored.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ borderRadius: 2 }}
    >
      <path d="M512 0H0V512H512V0Z" fill="black" />
      <path
        d="M322 377H377V421H307.857L278 391.143V322H322V377ZM421 307.857L391.143 278H322V322L377 322V377H421V307.857ZM234 278H190V322H234V278ZM91 391.143L120.857 421H234V377H135V278H91V391.143ZM371.172 189.999V120.856L341.315 90.9995H278V135H327.172V189.999H278V233.999H421V189.999H371.172ZM135 91H91V233.999H135V184.5H190V233.999H234V184.5L190 140.5H135V91ZM234 91H190V140.5H234V91Z"
        fill="#FAF74F"
      />
    </svg>
  )
}

function AiderIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  // SVG sourced from aider.chat/assets/icons/safari-pinned-tab.svg.
  // Why: className="text-current" opts out of shadcn's Select rule that forces
  // text-muted-foreground on any <svg> that lacks a text-* class.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 436 436"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="text-current"
    >
      <g transform="translate(0,436) scale(0.1,-0.1)" fill="currentColor" stroke="none">
        <path d="M0 2180 l0 -2180 2180 0 2180 0 0 2180 0 2180 -2180 0 -2180 0 0 -2180z m2705 1818 c20 -20 28 -121 30 -398 l2 -305 216 -5 c118 -3 218 -8 222 -12 3 -3 10 -46 15 -95 5 -48 16 -126 25 -172 17 -86 17 -81 -17 -233 -14 -67 -13 -365 2 -438 21 -100 22 -159 5 -247 -24 -122 -24 -363 1 -458 23 -88 23 -213 1 -330 -9 -49 -17 -109 -17 -132 l0 -43 203 0 c111 0 208 -4 216 -9 10 -6 18 -51 27 -148 8 -76 16 -152 20 -168 7 -39 -23 -361 -37 -387 -10 -18 -21 -19 -214 -16 -135 2 -208 7 -215 14 -22 22 -33 301 -21 501 6 102 8 189 5 194 -8 13 -417 12 -431 -2 -12 -12 -8 -146 8 -261 8 -55 8 -95 1 -140 -6 -35 -14 -99 -17 -143 -9 -123 -14 -141 -41 -154 -18 -8 -217 -11 -679 -11 l-653 0 -11 33 c-31 97 -43 336 -27 533 5 56 6 113 2 128 l-6 26 -194 0 c-211 0 -252 4 -261 28 -12 33 -17 392 -6 522 15 186 -2 174 260 180 115 3 213 8 217 12 4 4 1 52 -5 105 -7 54 -17 130 -22 168 -7 56 -5 91 11 171 10 55 22 130 26 166 4 36 10 72 15 79 7 12 128 15 665 19 l658 5 8 30 c5 18 4 72 -3 130 -12 115 -7 346 11 454 10 61 10 75 -1 82 -8 5 -300 9 -650 9 l-636 0 -27 25 c-18 16 -26 34 -26 57 0 18 -5 87 -10 153 -10 128 5 449 22 472 5 7 26 13 46 15 78 6 1281 3 1287 -4z" />
        <path d="M1360 1833 c0 -5 -1 -164 -3 -356 l-2 -347 625 -1 c704 -1 708 -1 722 7 5 4 7 20 4 38 -29 141 -32 491 -6 595 9 38 8 45 -7 57 -15 11 -139 13 -675 14 -362 0 -658 -3 -658 -7z" />
      </g>
    </svg>
  )
}

function AgentLetterIcon({
  letter,
  size = 14
}: {
  letter: string
  size?: number
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="text-current"
    >
      <rect width="14" height="14" rx="3" fill="currentColor" fillOpacity="0.2" />
      <text
        x="7"
        y="10.5"
        textAnchor="middle"
        fontSize="8.5"
        fill="currentColor"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {letter}
      </text>
    </svg>
  )
}

export function AgentIcon({
  agent,
  size = 14
}: {
  agent: TuiAgent | null | undefined
  size?: number
}): React.JSX.Element {
  // Why: render a neutral question-mark glyph when the agent identity is not
  // yet known. Before, the caller coerced null → 'claude', which caused Codex
  // panes to briefly show the Claude icon until the first hook callback
  // arrived.
  if (!agent) {
    return <AgentLetterIcon letter="?" size={size} />
  }
  if (agent === 'claude') {
    return <ClaudeIcon size={size} />
  }
  if (agent === 'codex') {
    return <OpenAIIcon size={size} />
  }
  if (agent === 'droid') {
    return <DroidIcon size={size} />
  }
  if (agent === 'pi') {
    return <PiIcon size={size} />
  }
  if (agent === 'aider') {
    return <AiderIcon size={size} />
  }
  if (agent === 'kilo') {
    return <KiloIcon size={size} />
  }
  const catalogEntry = AGENT_CATALOG.find((a) => a.id === agent)
  if (catalogEntry?.faviconDomain) {
    // Why: agents without a published SVG icon use their site favicon via
    // Google's favicon service — same source the README uses for the agent badge list.
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${catalogEntry.faviconDomain}&sz=64`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
        className={agent === 'copilot' ? 'dark:invert' : undefined}
      />
    )
  }
  const label = catalogEntry?.label ?? agent
  return <AgentLetterIcon letter={label.charAt(0).toUpperCase()} size={size} />
}
