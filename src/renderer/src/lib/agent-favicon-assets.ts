import type { TuiAgent } from '../../../shared/types'
import grokUrl from '../../../shared/agent-icons/grok.png?url'
import mimoCodeUrl from '../../../shared/agent-icons/mimo-code.png?url'
import anteUrl from '../../../shared/agent-icons/ante.png?url'
import geminiUrl from '../../../shared/agent-icons/gemini.png?url'
import antigravityUrl from '../../../shared/agent-icons/antigravity.png?url'
import gooseUrl from '../../../shared/agent-icons/goose.png?url'
import ampUrl from '../../../shared/agent-icons/amp.png?url'
import kiroUrl from '../../../shared/agent-icons/kiro.png?url'
import crushUrl from '../../../shared/agent-icons/crush.png?url'
import augUrl from '../../../shared/agent-icons/aug.png?url'
import autohandUrl from '../../../shared/agent-icons/autohand.png?url'
import clineUrl from '../../../shared/agent-icons/cline.png?url'
import codebuffUrl from '../../../shared/agent-icons/codebuff.png?url'
import commandCodeUrl from '../../../shared/agent-icons/command-code.png?url'
import continueUrl from '../../../shared/agent-icons/continue.png?url'
import cursorUrl from '../../../shared/agent-icons/cursor.png?url'
import kimiUrl from '../../../shared/agent-icons/kimi.png?url'
import mistralVibeUrl from '../../../shared/agent-icons/mistral-vibe.png?url'
import qwenCodeUrl from '../../../shared/agent-icons/qwen-code.png?url'
import rovoUrl from '../../../shared/agent-icons/rovo.png?url'
import hermesUrl from '../../../shared/agent-icons/hermes.png?url'
import devinUrl from '../../../shared/agent-icons/devin.png?url'
import openclawUrl from '../../../shared/agent-icons/openclaw.png?url'

// Why: these agents have no hand-authored SVG glyph, so previously their icons
// loaded live from Google's favicon service. That service is unreachable in some
// regions (e.g. mainland China) and offline, leaving broken images across the
// agent settings page, tab title bar, and status bar (#8451). Bundle the favicon
// PNGs at build time so the icons render without any network dependency.
// The PNGs live in src/shared/agent-icons so mobile (Metro) can bundle the same
// files; see mobile/src/components/mobile-agent-icon-assets.ts.
export const AGENT_FAVICON_ASSETS: Partial<Record<TuiAgent, string>> = {
  grok: grokUrl,
  'mimo-code': mimoCodeUrl,
  ante: anteUrl,
  gemini: geminiUrl,
  antigravity: antigravityUrl,
  goose: gooseUrl,
  amp: ampUrl,
  kiro: kiroUrl,
  crush: crushUrl,
  aug: augUrl,
  autohand: autohandUrl,
  cline: clineUrl,
  codebuff: codebuffUrl,
  'command-code': commandCodeUrl,
  continue: continueUrl,
  cursor: cursorUrl,
  kimi: kimiUrl,
  'mistral-vibe': mistralVibeUrl,
  'qwen-code': qwenCodeUrl,
  rovo: rovoUrl,
  hermes: hermesUrl,
  devin: devinUrl,
  openclaw: openclawUrl
}
