import { translate } from '@/i18n/i18n'
import {
  BROADCAST_TOOL_NAME,
  CLICK_ELEMENT_TOOL_NAME,
  DESCRIBE_SCREEN_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  MESSAGE_AGENT_TOOL_NAME,
  NAVIGATE_UI_TOOL_NAME,
  OPEN_URL_TOOL_NAME,
  READ_TERMINAL_TOOL_NAME,
  RUN_COMMAND_TOOL_NAME,
  SEE_SCREEN_TOOL_NAME,
  START_AGENT_TOOL_NAME,
  TYPE_INTO_TOOL_NAME
} from '../../../../shared/voice-control-types'

/**
 * The pill's one-line narration of a tool dispatch. Main sends the tool name and the
 * resolved agent's spoken name; the copy lives here so it is localized and so
 * model-facing tool output strings can never leak into the UI. Unknown tools are
 * internal diagnostics (roster snapshot, sideband notes) — null hides them.
 */
export function toolActivityLabel(tool: string, target?: string): string | null {
  switch (tool) {
    case LIST_AGENTS_TOOL_NAME:
      return translate(
        'auto.components.voice.control.voice.control.tool.activity.label.3581471fab',
        'Checking the roster…'
      )
    case MESSAGE_AGENT_TOOL_NAME:
      return target
        ? translate(
            'auto.components.voice.control.voice.control.tool.activity.label.6d91f4c490',
            'Waiting for {{name}} to reply…',
            { name: target }
          )
        : null
    case START_AGENT_TOOL_NAME:
      return target
        ? translate(
            'auto.components.voice.control.voice.control.tool.activity.label.338fc6bad1',
            'Starting an agent in {{name}}…',
            { name: target }
          )
        : null
    case BROADCAST_TOOL_NAME:
      return translate(
        'auto.components.voice.control.voice.control.tool.activity.label.4b3f0ee5f7',
        'Broadcast sent — waiting for replies…'
      )
    case NAVIGATE_UI_TOOL_NAME:
      return target
        ? translate(
            'auto.components.voice.control.voice.control.tool.activity.label.ddab1ccae7',
            'Navigating to {{name}}…',
            { name: target }
          )
        : null
    case DESCRIBE_SCREEN_TOOL_NAME:
      return translate(
        'auto.components.voice.control.voice.control.tool.activity.label.62508e1fd3',
        'Looking at your screen…'
      )
    case SEE_SCREEN_TOOL_NAME:
      return translate(
        'auto.components.voice.control.voice.control.tool.activity.label.6f1d8ef9ec',
        'Reading the screen…'
      )
    case CLICK_ELEMENT_TOOL_NAME:
      return target
        ? translate(
            'auto.components.voice.control.voice.control.tool.activity.label.f255e4edc1',
            'Clicking {{name}}…',
            { name: target }
          )
        : null
    case TYPE_INTO_TOOL_NAME:
      return target
        ? translate(
            'auto.components.voice.control.voice.control.tool.activity.label.971bbba281',
            'Typing into {{name}}…',
            { name: target }
          )
        : null
    case READ_TERMINAL_TOOL_NAME:
      return translate(
        'auto.components.voice.control.voice.control.tool.activity.label.e3b08d6076',
        'Reading the terminal…'
      )
    case RUN_COMMAND_TOOL_NAME:
      return translate(
        'auto.components.voice.control.voice.control.tool.activity.label.1453ef8e54',
        'Running a command…'
      )
    case OPEN_URL_TOOL_NAME:
      return target
        ? translate(
            'auto.components.voice.control.voice.control.tool.activity.label.245e6b241c',
            'Opening {{name}}…',
            { name: target }
          )
        : null
    default:
      return null
  }
}
